package app.libretv.player;

import android.view.View;

/** Short focus scale. One view moves; the row itself is not re-laid-out. */
final class FocusMotion {
    private FocusMotion() {}

    static void bind(View view) {
        view.setOnFocusChangeListener((v, focused) -> play(v, focused));
    }

    static void play(View view, boolean focused) {
        view.animate().cancel();
        view.animate()
                .scaleX(focused ? 1.06f : 1f)
                .scaleY(focused ? 1.06f : 1f)
                .setDuration(focused ? 140 : 90)
                .start();
    }
}
