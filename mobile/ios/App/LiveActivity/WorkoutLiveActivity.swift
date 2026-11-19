import ActivityKit
import SwiftUI
import WidgetKit

/// A workout going on, in the in-progress pill's voice (19 Nov, Alex; docs/DESIGN-RULES.md §6, `.tr-resume`): the green
/// dot still (a Live Activity can't pulse), the session's name, `In progress | Muscle Factory` grey, the clock counting
/// on the phone by itself, the sets done under it. White with ink words, ink with white ones in dark mode; no buttons, a
/// tap opens the workout. The system font: the repo holds Archivo only as .woff2, which iOS can't load.
struct WorkoutLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkoutAttributes.self) { context in
            WorkoutLockView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            LiveDot()
                            Text(context.state.name)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        if let gym = context.state.gym {
                            Text(gym)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(Look.grey)
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WorkoutClock(startedAt: context.attributes.startedAt, size: 28, color: .white, width: 116)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let sets = setsWords(context.state.sets) {
                        Text(sets)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(Look.grey)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 4)
                    }
                }
            } compactLeading: {
                // The app's dumbbell, white, with the green dot on it; training's indigo is too dark on the black island.
                ZStack(alignment: .topTrailing) {
                    DumbbellMark(width: 21)
                        .foregroundColor(.white)
                    LiveDot()
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

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    LiveDot()
                    // The name never cut (the pill on Training's rule): it shrinks a little before it would be.
                    Text(context.state.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(Look.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                HStack(spacing: 6) {
                    Text("In progress")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Look.grey)
                    if let gym = context.state.gym {
                        // The drawn bar between facts, never a typed one (§6, `Bars`).
                        Rectangle()
                            .fill(Look.grey.opacity(0.5))
                            .frame(width: 1, height: 10)
                        Text(gym)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(Look.grey)
                    }
                }
                .lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                WorkoutClock(startedAt: context.attributes.startedAt, size: 22, color: Look.ink, width: 96)
                if let sets = setsWords(context.state.sets) {
                    Text(sets)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Look.grey)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .activityBackgroundTint(Look.paper)
        .activitySystemActionForegroundColor(Look.ink)
        .widgetURL(URL(string: context.attributes.url))
    }
}

/// The clock from the start, `46:12`, `1:02:40` past an hour, counted by the phone with no pushes. Up to 12 h, as the
/// server ends a session left open; it stops there.
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
    var body: some View {
        Circle()
            .fill(Look.green)
            .frame(width: 6, height: 6)
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

/// `12 sets`, `1 set`; nothing before the first, as an empty thing says nothing.
func setsWords(_ sets: Int) -> String? {
    if sets <= 0 { return nil }
    return sets == 1 ? "1 set" : "\(sets) sets"
}

enum Look {
    static let green = Look.rgb(0x2f, 0x7a, 0x3f)
    static let grey = Look.rgb(0x8b, 0x93, 0xa1)
    /// White, ink in dark mode (Assets.xcassets).
    static let paper = Color("LiveBackground")
    /// Ink, white in dark mode.
    static let ink = Color("LiveInk")
    static let clockSpan: TimeInterval = 12 * 60 * 60

    static func rgb(_ r: Int, _ g: Int, _ b: Int) -> Color {
        return Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }
}
