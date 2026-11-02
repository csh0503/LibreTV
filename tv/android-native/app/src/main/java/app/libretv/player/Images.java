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

/** Small poster URLs, with the Douban mirrors the website falls back to. */
public final class Images {
    private static final RequestOptions OPTIONS = new RequestOptions()
            .override(185, 278)
            .centerCrop()
            .format(DecodeFormat.PREFER_RGB_565)
            .dontAnimate()
            .timeout(4000)
            .diskCacheStrategy(DiskCacheStrategy.ALL);

    private Images() {}

    public static void load(ImageView view, String url) {
        List<String> chain = candidates(url);
        view.setTag(chain);
        // 每次重新加载先把背景清回纯色，避免上一张的占位图残留
        view.setBackgroundColor(0xFF1A1A1A);
        if (chain.isEmpty()) {
            Glide.with(view).clear(view);
            placeholder(view);
            return;
        }
        into(view, chain, 0);
    }

    /** 所有候选地址都失败：给一张带胶片图标的占位，不要留一块空白。 */
    private static void placeholder(ImageView view) {
        view.setImageDrawable(null);
        view.setBackgroundResource(R.drawable.placeholder_poster);
    }

    private static void into(ImageView view, List<String> chain, int index) {
        if (view.getTag() != chain) return;
        if (index >= chain.size()) {
            placeholder(view);
            return;
        }
        Glide.with(view)
                .load(model(chain.get(index)))
                .apply(OPTIONS)
                .listener(new com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable>() {
                    @Override
                    public boolean onLoadFailed(com.bumptech.glide.load.engine.GlideException e, Object model, com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable> target, boolean isFirst) {
                        view.post(() -> into(view, chain, index + 1));
                        return true;
                    }

                    @Override
                    public boolean onResourceReady(android.graphics.drawable.Drawable resource, Object model, com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable> target, com.bumptech.glide.load.DataSource dataSource, boolean isFirst) {
                        return false;
                    }
                })
                .into(view);
    }

    static List<String> candidates(String url) {
        List<String> out = new ArrayList<>();
        if (url == null || url.isEmpty()) return out;
        String small = shrink(url);
        add(out, small);
        if (small.contains("doubanio.com")) {
            add(out, small.replaceAll("img\\d+\\.doubanio\\.com", "img.doubanio.cmliussss.net"));
            add(out, small.replaceAll("img\\d+\\.doubanio\\.com", "img.doubanio.cmliussss.com"));
        }
        add(out, Api.BASE + "/api/proxy?url=" + encode(small));
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

    private static String shrink(String url) {
        String next = url;
        next = next.replace("/t/p/original/", "/t/p/w185/");
        next = next.replaceAll("/t/p/w\\d+/", "/t/p/w185/");
        next = next.replace("/pic/cover/l/", "/pic/cover/c/");
        next = next.replace("/pic/cover/m/", "/pic/cover/c/");
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
