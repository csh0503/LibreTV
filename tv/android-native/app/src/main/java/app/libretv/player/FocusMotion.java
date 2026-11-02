package app.libretv.player;

import android.view.View;

/**
 * Short focus scale. One view moves; the row itself is not re-laid-out.
 *
 * 缩放幅度压到 1.04：1.06 时卡片在行首/行尾会顶出可视区，
 * 而且白色聚焦描边会被列表边界裁掉。1.04 + 列表两侧 12dp 内边距刚好放得下。
 * 轴线用中心点，左右上下对称长大，焦点环不会被拉偏。
 */
final class FocusMotion {
    private static final float SCALE = 1.04f;

    private FocusMotion() {}

    static void bind(View view) {
        view.setOnFocusChangeListener((v, focused) -> play(v, focused));
    }

    static void play(View view, boolean focused) {
        view.animate().cancel();
        view.setPivotX(view.getWidth() / 2f);
        view.setPivotY(view.getHeight() / 2f);
        view.animate()
                .scaleX(focused ? SCALE : 1f)
                .scaleY(focused ? SCALE : 1f)
                .setDuration(focused ? 140 : 90)
                .start();
    }
}
