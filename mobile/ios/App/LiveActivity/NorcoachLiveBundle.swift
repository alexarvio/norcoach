import SwiftUI
import WidgetKit

/// The NorcoachLive extension (19 Nov, Alex): it draws the workout going on, on the lock screen and in the Dynamic
/// Island, and nothing else. No home-screen widgets.
@main
struct NorcoachLiveBundle: WidgetBundle {
    var body: some Widget {
        WorkoutLiveActivity()
    }
}
