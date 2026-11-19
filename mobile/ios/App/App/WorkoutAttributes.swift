import Foundation
import ActivityKit

/// A workout going on, as the lock screen and the Dynamic Island show it (19 Nov, Alex: "a pill on the lock screen of my
/// iphone whenever there is an ongoing workout"). One file compiled into both the app and the NorcoachLive extension
/// (mobile/ios/scripts/add_live_activity.rb), so the two can never drift apart: ActivityKit matches them by this shape.
/// What never changes for a session is here; what can (its name, a gym switched mid-session, the sets done, the set
/// next) is the content state the app updates. Changing a field here leaves activities started by an older build
/// unreadable, so add new fields as optionals (or, as finishUrl, read with a fallback below).
@available(iOS 16.1, *)
struct WorkoutAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// The session's label, as the in-progress pill on Training says it: `Upper`, `Rogue session`.
        var name: String
        /// The gym it is at, none for a session with no gym. Shown only when nothing else is known (19 Nov, Alex: C).
        var gym: String?
        /// Working sets done so far.
        var sets: Int
        /// The working sets planned on the session's planned exercises; none for a rogue session (no bar, `9 sets`).
        var total: Int?
        /// The exercise with the next set still to do; none once every set is in (`All sets done`) or when unknown.
        var exercise: String?
        /// That set's number and the exercise's set count: `Set 3 of 4`.
        var setNo: Int?
        var setOf: Int?
        /// That set's planned figures as words, `60 kg × 10–12`; none when the coach set none, or on a swap or a rogue session.
        var target: String?
    }

    /// The program day the session is on: with startedAt, what makes one session (a reopened one starts afresh).
    var dayId: Int
    /// When it began; the clock counts on the phone from here, with no pushes.
    var startedAt: Date
    /// Where a tap opens: the live workout (`/client?workout=<dayId>`).
    var url: String
    /// Where Finish opens: the workout's wrap-up (`/client?workout=<dayId>&finish=1`; 19 Nov, Alex: C).
    var finishUrl: String
    /// The coach's business name, shown small at the top only while the coach has a brand colour (19 Nov, Alex: C).
    var coach: String?
    /// The coach's brand colour as stored (`#2346a8`), already dark enough for white words; it fills the sets bar.
    var brand: String?

    enum CodingKeys: String, CodingKey {
        case dayId, startedAt, url, finishUrl, coach, brand
    }
}

/// Read by hand so an activity started by the build before Finish (no finishUrl) still draws: its Finish goes to the
/// wrap-up of its own day (19 Nov, Alex: C). Encoding stays the compiler's.
@available(iOS 16.1, *)
extension WorkoutAttributes {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dayId = try c.decode(Int.self, forKey: .dayId)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        url = try c.decode(String.self, forKey: .url)
        finishUrl = try c.decodeIfPresent(String.self, forKey: .finishUrl) ?? "https://app.norcoachapp.com/client?workout=\(dayId)&finish=1"
        coach = try c.decodeIfPresent(String.self, forKey: .coach)
        brand = try c.decodeIfPresent(String.self, forKey: .brand)
    }
}
