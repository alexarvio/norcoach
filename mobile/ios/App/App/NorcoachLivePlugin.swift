import Foundation
import Capacitor
import ActivityKit

/// The workout on the lock screen and in the Dynamic Island (19 Nov, Alex: "i forget to complete the workout and it runs
/// and i notice whenever i open the app again maybe hours later"). The page tells it when a session starts, changes and
/// ends (app/lib/liveActivity.ts); the clock counts on the phone by itself. Called through window.Capacitor as
/// "NorcoachLive"; the page checks PluginHeaders first, so an older build without it is never asked.
///
///   start({dayId, startedAt, url?, finishUrl?, coach?, brand?, name, gym?, sets?, total?, exercise?, setNo?, setOf?,
///          target?})                                    shows it; again for the same dayId and startedAt is an update
///                                                       (url, finishUrl, coach and brand are the activity's own and
///                                                       never change after its start). startedAt is epoch
///                                                       milliseconds (an ISO string is read too).
///                                                       Resolves {active, id?, reason?: "unsupported" | "disabled"}.
///   update({dayId, name?, gym?, sets?, total?, exercise?, setNo?, setOf?, target?})
///                                                       the name, gym (null for none; left out, kept) and sets done,
///                                                       and the set next (19 Nov, Alex: C): each of total, exercise,
///                                                       setNo, setOf and target left out or null is none. {active}
///   end({dayId?})                                       takes it down at once; with no dayId, every one. {ended}
///   sync({keep: {dayId, startedAt} | null})             ends every one but the kept one. {kept, ended}
///
/// The app stays on iOS 15, so every ActivityKit call is behind iOS 16.1; below that each method resolves as unsupported.
@objc(NorcoachLivePlugin)
public class NorcoachLivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NorcoachLivePlugin"
    public let jsName = "NorcoachLive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
    ]

    @objc func start(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            LiveWorkout.start(call)
        } else {
            call.resolve(["active": false, "reason": "unsupported"])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            LiveWorkout.update(call)
        } else {
            call.resolve(["active": false, "reason": "unsupported"])
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            LiveWorkout.end(call)
        } else {
            call.resolve(["ended": 0])
        }
    }

    @objc func sync(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            LiveWorkout.sync(call)
        } else {
            call.resolve(["kept": false, "ended": 0])
        }
    }
}

@available(iOS 16.1, *)
private enum LiveWorkout {
    typealias Workout = Activity<WorkoutAttributes>

    /// Shown until 12 h after the start, as the server ends a session left open (STALE_SESSION_MS); iOS takes a Live
    /// Activity down after 8 h of its own accord anyway.
    static let staleAfter: TimeInterval = 12 * 60 * 60
    static let site = "app.norcoachapp.com"

    // MARK: the four calls. Each runs its look-up and any request on the main queue in one go, so two quick starts for one
    // session can never both find nothing and both request one; the ending and updating that follow are async.

    static func start(_ call: CAPPluginCall) {
        guard let dayId = call.getInt("dayId"), let startedAt = date(call, "startedAt") else {
            call.reject("dayId and startedAt are needed")
            return
        }
        let state = next(call, on: WorkoutAttributes.ContentState(
            name: name(call.getString("name")) ?? "Workout",
            gym: gym(call.getString("gym")),
            sets: max(0, call.getInt("sets") ?? 0)
        ))
        let link = url(call.getString("url"), dayId: dayId)
        let finishLink = url(call.getString("finishUrl"), dayId: dayId, finish: true)
        let coach = name(call.getString("coach"))
        let brand = hex(call.getString("brand"))
        DispatchQueue.main.async {
            let all = Workout.activities
            let mine = all.first { isLive($0) && same($0, dayId: dayId, startedAt: startedAt) }
            // One workout at a time: any other (a session ended elsewhere, an older start) goes as this one comes.
            let others = all.filter { $0.id != mine?.id }
            if let mine = mine {
                Task {
                    for other in others { await endNow(other) }
                    await push(mine, state)
                    call.resolve(["active": true, "id": mine.id])
                }
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                Task {
                    for other in others { await endNow(other) }
                    call.resolve(["active": false, "reason": "disabled"])
                }
                return
            }
            let attributes = WorkoutAttributes(dayId: dayId, startedAt: startedAt, url: link, finishUrl: finishLink, coach: coach, brand: brand)
            do {
                let made: Workout
                if #available(iOS 16.2, *) {
                    made = try Workout.request(
                        attributes: attributes,
                        content: ActivityContent(state: state, staleDate: startedAt.addingTimeInterval(staleAfter)),
                        pushType: nil
                    )
                } else {
                    // The 16.1 call: a tester's iPhone is on 16.1, which has no stale date.
                    made = try Workout.request(attributes: attributes, contentState: state, pushType: nil)
                }
                Task {
                    for other in others { await endNow(other) }
                    call.resolve(["active": true, "id": made.id])
                }
            } catch {
                Task {
                    for other in others { await endNow(other) }
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    static func update(_ call: CAPPluginCall) {
        guard let dayId = call.getInt("dayId") else {
            call.reject("dayId is needed")
            return
        }
        let newName = name(call.getString("name"))
        // A gym left out keeps the one showing; null (or "") is no gym.
        let gymGiven = call.getValue("gym") != nil
        let newGym = gym(call.getString("gym"))
        let newSets = call.getInt("sets")
        // The set next is sent whole each time (19 Nov, Alex: C): what is left out is none.
        let told = next(call, on: WorkoutAttributes.ContentState(name: "", gym: nil, sets: 0))
        DispatchQueue.main.async {
            guard let mine = Workout.activities.first(where: { isLive($0) && $0.attributes.dayId == dayId }) else {
                call.resolve(["active": false])
                return
            }
            var state = current(mine)
            if let newName = newName { state.name = newName }
            if gymGiven { state.gym = newGym }
            if let newSets = newSets { state.sets = max(0, newSets) }
            state.total = told.total
            state.exercise = told.exercise
            state.setNo = told.setNo
            state.setOf = told.setOf
            state.target = told.target
            Task {
                await push(mine, state)
                call.resolve(["active": true, "id": mine.id])
            }
        }
    }

    static func end(_ call: CAPPluginCall) {
        let dayId = call.getInt("dayId")
        DispatchQueue.main.async {
            let going = Workout.activities.filter { dayId == nil || $0.attributes.dayId == dayId }
            Task {
                for activity in going { await endNow(activity) }
                call.resolve(["ended": going.count])
            }
        }
    }

    static func sync(_ call: CAPPluginCall) {
        let keep = call.getObject("keep")
        let keepDay = keep?["dayId"] as? Int
        let keepStart = keep.flatMap { date($0["startedAt"]) }
        DispatchQueue.main.async {
            let all = Workout.activities
            let kept = all.first { activity in
                guard let keepDay = keepDay, let keepStart = keepStart else { return false }
                return isLive(activity) && same(activity, dayId: keepDay, startedAt: keepStart)
            }
            let going = all.filter { $0.id != kept?.id }
            Task {
                for activity in going { await endNow(activity) }
                call.resolve(["kept": kept != nil, "ended": going.count])
            }
        }
    }

    // MARK: ActivityKit, the 16.2 calls where there are, the 16.1 ones below them.

    static func push(_ activity: Workout, _ state: WorkoutAttributes.ContentState) async {
        if #available(iOS 16.2, *) {
            await activity.update(ActivityContent(state: state, staleDate: activity.attributes.startedAt.addingTimeInterval(staleAfter)))
        } else {
            await activity.update(using: state)
        }
    }

    /// Down at once (an end in the app has its own `Upper saved`; a discard has nothing to say).
    static func endNow(_ activity: Workout) async {
        if #available(iOS 16.2, *) {
            await activity.end(nil, dismissalPolicy: .immediate)
        } else {
            await activity.end(using: nil, dismissalPolicy: .immediate)
        }
    }

    static func current(_ activity: Workout) -> WorkoutAttributes.ContentState {
        if #available(iOS 16.2, *) {
            return activity.content.state
        } else {
            return activity.contentState
        }
    }

    /// Still on the phone: active, or past its stale date but not yet ended.
    static func isLive(_ activity: Workout) -> Bool {
        return activity.activityState != .ended && activity.activityState != .dismissed
    }

    /// One session: its day and its start, to the second (a reopened session keeps its start, a new one has its own).
    static func same(_ activity: Workout, dayId: Int, startedAt: Date) -> Bool {
        return activity.attributes.dayId == dayId && abs(activity.attributes.startedAt.timeIntervalSince(startedAt)) < 1
    }

    // MARK: reading what the page sent.

    static func date(_ call: CAPPluginCall, _ key: String) -> Date? {
        return date(call.getValue(key))
    }

    /// Epoch milliseconds, or an ISO 8601 string with or without its fraction.
    static func date(_ value: Any?) -> Date? {
        if let ms = value as? Double, ms > 0 {
            return Date(timeIntervalSince1970: ms / 1000)
        }
        if let ms = value as? Int, ms > 0 {
            return Date(timeIntervalSince1970: Double(ms) / 1000)
        }
        guard let text = value as? String else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func name(_ raw: String?) -> String? {
        let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    static func gym(_ raw: String?) -> String? {
        return name(raw)
    }

    /// Only a link into the app's own site; anything else opens the workout by its day (Finish: its wrap-up).
    static func url(_ raw: String?, dayId: Int, finish: Bool = false) -> String {
        if let raw = raw, let parsed = URL(string: raw), parsed.scheme == "https", parsed.host == site {
            return raw
        }
        return "https://\(site)/client?workout=\(dayId)" + (finish ? "&finish=1" : "")
    }

    /// The set next, as start and update send it (19 Nov, Alex: C). A count left out or below one is none.
    static func next(_ call: CAPPluginCall, on base: WorkoutAttributes.ContentState) -> WorkoutAttributes.ContentState {
        var state = base
        state.total = positive(call.getInt("total"))
        state.exercise = name(call.getString("exercise"))
        state.setNo = positive(call.getInt("setNo"))
        state.setOf = positive(call.getInt("setOf"))
        state.target = name(call.getString("target"))
        return state
    }

    static func positive(_ value: Int?) -> Int? {
        guard let value = value, value > 0 else { return nil }
        return value
    }

    /// The coach's brand as `#rrggbb`, or none for anything that isn't six hex digits (with or without its #).
    static func hex(_ raw: String?) -> String? {
        guard var text = name(raw) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, text.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#" + text.lowercased()
    }
}
