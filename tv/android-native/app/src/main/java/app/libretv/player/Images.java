package app.libretv.player;

import android.widget.ImageView;

import com.bumptech.glide.Glide;
import com.bumptech.glide.load.DecodeFormat;
import com.bumptech.glide.load.engine.DiskCacheStrategy;
import com.bumptech.glide.load.model.GlideUrl;
import com.bumptech.glide.load.model.LazyHeaders;
import com.bumptech.glide.request.RequestOptions;

import java.util.ArrayList;
import java.util.List;

/**
 * 海报加载。原来一律按 185x278 解码，在 1080p 电视上（卡片实际 234px 宽、片库格子 350px）
 * 明显偏糊。现在按用途分两档：卡片 342px、大图 780px，同时把豆瓣的 /c/ 换成 /l/。
 */
public final class Images {
    /** 卡片：货架海报、搜索结果、详情页左侧小海报 */
    private static final RequestOptions CARD = new RequestOptions()
            .override(342, 513)
            .centerCrop()
            .format(DecodeFormat.PREFER_RGB_565)
            .dontAnimate()
            .timeout(4000)
            .diskCacheStrategy(DiskCacheStrategy.ALL);

    /** 大图：首屏引导图。RGB_565 在渐变海报上会有色带，这里用 ARGB_8888。 */
    private static final RequestOptions LARGE = new RequestOptions()
            .override(1280, 720)
            .centerCrop()
            .format(DecodeFormat.PREFER_ARGB_8888)
            .dontAnimate()
            .timeout(5000)
            .diskCacheStrategy(DiskCacheStrategy.ALL);

    private Images() {}

    public static void load(ImageView view, String url) {
        load(view, url, CARD, 342);
    }

    public static void loadLarge(ImageView view, String url) {
        load(view, url, LARGE, 1280);
    }

    private static void load(ImageView view, String url, RequestOptions options, int width) {
        List<String> chain = candidates(url, width);
        view.setTag(chain);
        // 每次重新加载先把背景清回纯色，避免上一张的占位图残留
        view.setBackgroundColor(0xFF1A1A1A);
        if (chain.isEmpty()) {
            Glide.with(view).clear(view);
            placeholder(view);
            return;
        }
        into(view, chain, 0, options);
    }

    /** 所有候选地址都失败：给一张带胶片图标的占位，不要留一块空白。 */
    private static void placeholder(ImageView view) {
        view.setImageDrawable(null);
        view.setBackgroundResource(R.drawable.placeholder_poster);
    }

    private static void into(ImageView view, List<String> chain, int index, RequestOptions options) {
        if (view.getTag() != chain) return;
        if (index >= chain.size()) {
            placeholder(view);
            return;
        }
        Glide.with(view)
                .load(model(chain.get(index)))
                .apply(options)
                .listener(new com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable>() {
                    @Override
                    public boolean onLoadFailed(com.bumptech.glide.load.engine.GlideException e, Object model, com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable> target, boolean isFirst) {
                        view.post(() -> into(view, chain, index + 1, options));
                        return true;
                    }

                    @Override
                    public boolean onResourceReady(android.graphics.drawable.Drawable resource, Object model, com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable> target, com.bumptech.glide.load.DataSource dataSource, boolean isFirst) {
                        return false;
                    }
                })
                .into(view);
    }

    static List<String> candidates(String url, int width) {
        List<String> out = new ArrayList<>();
        if (url == null || url.isEmpty()) return out;
        String sized = resize(url, width);
        add(out, sized);
        if (sized.contains("doubanio.com")) {
            add(out, sized.replaceAll("img\\d+\\.doubanio\\.com", "img.doubanio.cmliussss.net"));
            add(out, sized.replaceAll("img\\d+\\.doubanio\\.com", "img.doubanio.cmliussss.com"));
        }
        add(out, Api.BASE + "/api/proxy?url=" + encode(sized));
        return out;
    }

    /** Douban rejects an empty Referer. The mirror and the site proxy do not need one. */
    private static Object model(String url) {
        if (url.contains("doubanio.com") && !url.contains("/api/proxy") && !url.contains("cmliussss.")) {
            return new GlideUrl(url, new LazyHeaders.Builder().addHeader("Referer", "https://movie.douban.com/").build());
        }
        return url;
    }

    private static void add(List<String> out, String url) {
        if (url != null && !url.isEmpty() && !out.contains(url)) out.add(url);
    }

    /**
     * 把图片地址换成对应尺寸：
     * TMDB 有 w185 / w342 / w500 / w780 / original；豆瓣封面 s / m / l，l 大约 500px 宽。
     */
    private static String resize(String url, int width) {
        String next = url;
        String tmdbSize = width >= 780 ? "w780" : width >= 500 ? "w500" : "w342";
        next = next.replace("/t/p/original/", "/t/p/" + tmdbSize + "/");
        next = next.replaceAll("/t/p/w\\d+/", "/t/p/" + tmdbSize + "/");
        // 豆瓣：l 比 c 大得多，卡片宽度 234px 以上就该用 l
        if (width >= 300) {
            next = next.replace("/pic/cover/s/", "/pic/cover/l/");
            next = next.replace("/pic/cover/m/", "/pic/cover/l/");
            next = next.replace("/pic/cover/c/", "/pic/cover/l/");
        } else {
            next = next.replace("/pic/cover/l/", "/pic/cover/c/");
            next = next.replace("/pic/cover/m/", "/pic/cover/c/");
        }
        return next;
    }

    private static String encode(String url) {
        try {
            return java.net.URLEncoder.encode(url, "UTF-8");
        } catch (Exception e) {
            return url;
        }
    }
}
