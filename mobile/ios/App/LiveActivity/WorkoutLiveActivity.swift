import ActivityKit
import SwiftUI
import WidgetKit

/// A workout going on (19 Nov, Alex: C of docs/boards/live-activity-mockup.html, "A with the coach on it"; docs/DESIGN-RULES.md
/// §6): the coach's business small at the top while they have a brand colour, then the session with the green dot (still:
/// a Live Activity can't pulse) and the clock counting on the phone by itself, the exercise with the next set and the
/// sets done of those planned, `Set 3 | 60 kg × 10` with Finish on its right, and a thin bar of the sets done in the
/// coach's colour. Dark with white words in dark mode, white with ink ones in light mode. A tap opens the workout,
/// Finish its wrap-up (a Link: no AppIntents, so it works from iOS 16.1). The system font: the repo holds Archivo only as
/// .woff2, which iOS can't load.
struct WorkoutLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkoutAttributes.self) { context in
            WorkoutLockView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Held open: the lock screen's lines on the island's black, without the coach's name.
                DynamicIslandExpandedRegion(.leading) {
                    SessionName(name: context.state.name, color: .white)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WorkoutClock(startedAt: context.attributes.startedAt, size: 24, color: .white, width: Look.clockWidth)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    WorkoutLines(attributes: context.attributes, state: context.state, palette: Palette(dark: true, brand: context.attributes.brand))
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                // The app's dumbbell, white, with the green dot on it; training's indigo is too dark on the black island.
                ZStack(alignment: .topTrailing) {
                    DumbbellMark(width: 21)
                        .foregroundColor(.white)
                    LiveDot(size: 6, color: Look.green)
                        .offset(x: 3, y: -3)
                }
                .padding(.leading, 2)
            } compactTrailing: {
                // A fixed width: a counting Text otherwise takes all the room it can.
                WorkoutClock(startedAt: context.attributes.startedAt, size: 15, color: .white, width: 56)
            } minimal: {
                DumbbellMark(width: 18)
                    .foregroundColor(.white)
            }
            .widgetURL(URL(string: context.attributes.url))
            .keylineTint(Look.green)
        }
    }
}

/// The lock screen (and the banner on a phone with no Dynamic Island).
struct WorkoutLockView: View {
    let context: ActivityViewContext<WorkoutAttributes>
    @Environment(\.colorScheme) private var scheme

    private var palette: Palette {
        Palette(dark: scheme == .dark, brand: context.attributes.brand)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Where Apple's own apps put their name; Norcoach's never shows.
            if let coach = context.attributes.coach {
                Text(coach.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.6)
                    .foregroundColor(palette.ink)
                    .opacity(0.55)
                    .lineLimit(1)
                    .padding(.bottom, 6)
            }
            HStack(alignment: .center, spacing: 8) {
                SessionName(name: context.state.name, color: palette.ink)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                WorkoutClock(startedAt: context.attributes.startedAt, size: 24, color: palette.ink, width: Look.clockWidth)
            }
            WorkoutLines(attributes: context.attributes, state: context.state, palette: palette)
        }
        .padding(.horizontal, 20)
        .padding(.top, 15)
        .padding(.bottom, 14)
        .activityBackgroundTint(Look.paper)
        .activitySystemActionForegroundColor(Look.ink)
        .widgetURL(URL(string: context.attributes.url))
    }
}

/// Under the session and the clock, on the lock screen and the island alike: the exercise and the sets done, the set
/// next with Finish, the bar.
struct WorkoutLines: View {
    let attributes: WorkoutAttributes
    let state: WorkoutAttributes.ContentState
    let palette: Palette

    private var lead: String? { exerciseWords(state) }
    private var count: String? { setsWords(state.sets, total: state.total) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if lead != nil || count != nil {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let lead = lead {
                        Text(lead)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(palette.ink)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if let count = count {
                        Text(count)
                            .font(.system(size: 13, weight: .medium).monospacedDigit())
                            .foregroundColor(palette.grey)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .padding(.top, 6)
            }
            HStack(alignment: .center, spacing: 8) {
                SetLine(state: state, color: palette.grey)
                Spacer(minLength: 8)
                if let finish = URL(string: attributes.finishUrl) {
                    Link(destination: finish) {
                        Text("Finish")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(palette.finishWords)
                            .lineLimit(1)
                            .padding(.vertical, 7)
                            .padding(.horizontal, 14)
                            .background(Capsule().fill(palette.finish))
                    }
                    .fixedSize()
                }
            }
            .padding(.top, 2)
            // Sets done of those planned; a rogue session has no plan, so no bar.
            if let total = state.total, total > 0 {
                SetsTrack(done: state.sets, total: total, track: palette.track, fill: palette.fill)
                    .padding(.top, 11)
            }
        }
    }
}

/// `Set 3 of 4 | 60 kg × 10`, only the parts known, parted by the drawn bar (§6, `Bars`); nothing once every set is in.
struct SetLine: View {
    let state: WorkoutAttributes.ContentState
    let color: Color

    private var words: String? { setWords(state) }
    private var target: String? { state.exercise == nil ? nil : state.target }

    var body: some View {
        HStack(spacing: 7) {
            if let words = words {
                Text(words)
                    .lineLimit(1)
                    .fixedSize()
            }
            if words != nil && target != nil {
                Rectangle()
                    .fill(color.opacity(0.5))
                    .frame(width: 1, height: 12)
            }
            if let target = target {
                Text(target)
                    .lineLimit(1)
            }
        }
        .font(.system(size: 13.5, weight: .medium).monospacedDigit())
        .foregroundColor(color)
    }
}

/// The session's name with the live dot. Never cut (the pill on Training's rule): it shrinks a little before it would be.
struct SessionName: View {
    let name: String
    let color: Color

    var body: some View {
        HStack(spacing: 7) {
            LiveDot(size: 7, color: Look.live)
            Text(name)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

/// The thin bar, 3pt, filled by the sets done.
struct SetsTrack: View {
    let done: Int
    let total: Int
    let track: Color
    let fill: Color

    private var share: CGFloat {
        return min(1, max(0, CGFloat(done) / CGFloat(total)))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(fill).frame(width: geo.size.width * share)
            }
        }
        .frame(height: 3)
    }
}

/// The clock from the start, `46:12`, `1:02:40` past an hour, counted by the phone with no pushes. Up to 12 h, as the
/// server ends a session left open; it stops there. A fixed width, so it never jumps as it counts.
struct WorkoutClock: View {
    let startedAt: Date
    let size: CGFloat
    let color: Color
    let width: CGFloat

    var body: some View {
        Text(timerInterval: startedAt...startedAt.addingTimeInterval(Look.clockSpan), countsDown: false)
            .font(.system(size: size, weight: .semibold).monospacedDigit())
            .foregroundColor(color)
            .multilineTextAlignment(.trailing)
            .lineLimit(1)
            .frame(width: width, alignment: .trailing)
    }
}

/// The live dot, green and still.
struct LiveDot: View {
    let size: CGFloat
    let color: Color

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }
}

/// The app's training icon (TRACK_ICON, app/components/icons.tsx DumbbellIcon) as a template vector, in its 24:16 shape.
struct DumbbellMark: View {
    let width: CGFloat

    var body: some View {
        Image("Dumbbell")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: width, height: width * 16 / 25)
    }
}

/// The exercise with the next set; `All sets done` once every planned set is in; the gym when nothing else is known.
func exerciseWords(_ state: WorkoutAttributes.ContentState) -> String? {
    if let exercise = state.exercise { return exercise }
    if let total = state.total, total > 0 { return "All sets done" }
    return state.gym
}

/// `9 of 18 sets`; with no plan `9 sets`, and nothing before the first, as an empty thing says nothing.
func setsWords(_ sets: Int, total: Int?) -> String? {
    if let total = total, total > 0 {
        return "\(max(0, sets)) of \(total) " + (total == 1 ? "set" : "sets")
    }
    if sets <= 0 { return nil }
    return sets == 1 ? "1 set" : "\(sets) sets"
}

/// `Set 3 of 4`, `Set 3` with no count; nothing with no exercise.
func setWords(_ state: WorkoutAttributes.ContentState) -> String? {
    guard state.exercise != nil, let setNo = state.setNo else { return nil }
    if let setOf = state.setOf { return "Set \(setNo) of \(setOf)" }
    return "Set \(setNo)"
}

/// The colours for dark (the pill in dark mode, and the island) and light.
struct Palette {
    let dark: Bool
    let brand: String?

    var ink: Color { dark ? .white : Look.ink900 }
    var grey: Color { dark ? Color.white.opacity(0.55) : Look.grey }
    var track: Color { dark ? Color.white.opacity(0.18) : Look.rgb(0xe6, 0xe9, 0xee) }
    /// The coach's colour when they have one (in the dark mixed toward white so it reads), else white or ink.
    var fill: Color {
        if let brand = Look.hex(brand, towardWhite: dark ? 0.45 : 0) { return brand }
        return dark ? .white : Look.ink900
    }
    /// Finish: white with ink words in the dark, ink with white words in the light.
    var finish: Color { dark ? .white : Look.ink900 }
    var finishWords: Color { dark ? Look.ink900 : .white }
}

enum Look {
    /// The compact island's dot and keyline, as before.
    static let green = Look.rgb(0x2f, 0x7a, 0x3f)
    /// The dot on the lock screen and the island held open (19 Nov, Alex: C).
    static let live = Look.rgb(0x34, 0xa8, 0x53)
    static let grey = Look.rgb(0x8b, 0x93, 0xa1)
    static let ink900 = Look.rgb(0x14, 0x1a, 0x24)
    /// White, ink in dark mode (Assets.xcassets).
    static let paper = Color("LiveBackground")
    /// Ink, white in dark mode.
    static let ink = Color("LiveInk")
    static let clockSpan: TimeInterval = 12 * 60 * 60
    /// Room for `10:00:00` at 24pt, so the clock never moves the name.
    static let clockWidth: CGFloat = 108

    static func rgb(_ r: Int, _ g: Int, _ b: Int) -> Color {
        return Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }

    /// `#2346a8` (or without its #) as a colour, mixed `towardWhite` of the way to white; none for anything else.
    static func hex(_ raw: String?, towardWhite mix: Double) -> Color? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = Int(text, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xff) / 255
        let g = Double((value >> 8) & 0xff) / 255
        let b = Double(value & 0xff) / 255
        return Color(red: r + (1 - r) * mix, green: g + (1 - g) * mix, blue: b + (1 - b) * mix)
    }
}
