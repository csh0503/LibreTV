package app.libretv.player;

import android.app.Activity;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;

public final class Open {
    private Open() {}

    public static void card(Activity activity, Card card) {
        detail(activity, card.title, card.vodId, card.sourceJson, card.episode, card.positionSeconds, card.image, card.subtitle);
    }

    public static void detail(Activity activity, String title, String vodId, String sourceJson, int episode, int positionSeconds) {
        detail(activity, title, vodId, sourceJson, episode, positionSeconds, "", "");
    }

    public static void detail(Activity activity, String title, String vodId, String sourceJson, int episode, int positionSeconds, String image, String subtitle) {
        Intent detail = new Intent(activity, TitleActivity.class);
        detail.putExtra(TitleActivity.TITLE, title);
        detail.putExtra(TitleActivity.VOD_ID, vodId);
        detail.putExtra(TitleActivity.SOURCE, sourceJson);
        detail.putExtra(TitleActivity.EPISODE, episode);
        detail.putExtra(TitleActivity.POSITION, positionSeconds);
        detail.putExtra(TitleActivity.IMAGE, image);
        detail.putExtra(TitleActivity.SUB, subtitle);
        activity.startActivity(detail);
    }

    public static void play(Activity activity, String title, String url, int positionSeconds) {
        play(activity, title, url, positionSeconds, null);
    }

    public static void play(Activity activity, String title, String url, int positionSeconds, JSONObject watch) {
        Intent player = new Intent(activity, PlayerActivity.class);
        player.putExtra(PlayerActivity.TITLE, title);
        player.putExtra(PlayerActivity.URL, url);
        player.putExtra(PlayerActivity.POSITION, positionSeconds);
        if (watch != null) player.putExtra(PlayerActivity.WATCH, watch.toString());
        activity.startActivity(player);
    }

    public static String sourceJson(JSONObject item) {
        String key = item.optString("sourceKey");
        String url = item.optString("sourceUrl");
        try {
            return NativeApp.api().sourceFor(key, url).toString();
        } catch (Exception e) {
            JSONObject made = new JSONObject();
            try {
                if (!key.isEmpty()) made.put("key", key);
                if (!url.isEmpty()) made.put("url", url);
                made.put("name", item.optString("sourceName", key));
            } catch (JSONException ignored) {
                return "";
            }
            return made.optString("url").isEmpty() ? "" : made.toString();
        }
    }
}
