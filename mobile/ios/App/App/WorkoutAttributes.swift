import Foundation
import ActivityKit

/// A workout going on, as the lock screen and the Dynamic Island show it (19 Nov, Alex: "a pill on the lock screen of my
/// iphone whenever there is an ongoing workout"). One file compiled into both the app and the NorcoachLive extension
/// (mobile/ios/scripts/add_live_activity.rb), so the two can never drift apart: ActivityKit matches them by this shape.
/// What never changes for a session is here; what can (its name, a gym switched mid-session, the sets done) is the
/// content state the app updates. Changing a field here leaves activities started by an older build unreadable, so add
/// new fields as optionals.
@available(iOS 16.1, *)
struct WorkoutAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// The session's label, as the in-progress pill on Training says it: `Upper`, `Rogue session`.
        var name: String
        /// The gym it is at, none for a session with no gym.
        var gym: String?
        /// Sets done so far, working and warm-up.
        var sets: Int
    }

    /// The program day the session is on: with startedAt, what makes one session (a reopened one starts afresh).
    var dayId: Int
    /// When it began; the clock counts on the phone from here, with no pushes.
    var startedAt: Date
    /// Where a tap opens: the live workout (`/client?workout=<dayId>`).
    var url: String
}
