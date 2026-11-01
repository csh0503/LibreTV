package app.libretv.player;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;

/** Keeps the episode position, then writes it into the same cloud profile the website uses. */
public final class HistorySync {
    private static final String OVERLAY = "history_overlay";

    private HistorySync() {}

    public static void remember(Context context, JSONObject row) {
        JSONArray rows = overlay(NativeApp.api().cookies().prefs().getString(OVERLAY, "[]"));
        String key = row.optString("sourceKey") + "\n" + row.optString("vodId");
        JSONArray next = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject item = rows.optJSONObject(i);
            if (item == null) continue;
            String itemKey = item.optString("sourceKey") + "\n" + item.optString("vodId");
            if (!itemKey.equals(key)) next.put(item);
        }
        next.put(row);
        NativeApp.api().cookies().prefs().edit().putString(OVERLAY, next.toString()).apply();
    }

    public static JSONArray merge(JSONArray remote) {
        JSONArray rows = remote == null ? new JSONArray() : remote;
        JSONArray local = overlay(NativeApp.api().cookies().prefs().getString(OVERLAY, "[]"));
        if (local.length() == 0) return rows;
        JSONArray merged = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject item = rows.optJSONObject(i);
            if (item != null) merged.put(item);
        }
        for (int i = 0; i < local.length(); i++) {
            JSONObject item = local.optJSONObject(i);
            if (item != null) merged.put(item);
        }
        return merged;
    }

    public static void push(String profileId) throws IOException {
        try {
            pushBundle(profileId);
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        }
    }

    private static void pushBundle(String profileId) throws IOException, org.json.JSONException {
        if (profileId == null || profileId.isEmpty()) return;
        JSONArray pending = overlay(NativeApp.api().cookies().prefs().getString(OVERLAY, "[]"));
        if (pending.length() == 0) return;
        JSONArray profiles = NativeApp.api().profiles();
        JSONObject profile = null;
        if (profiles != null) {
            for (int i = 0; i < profiles.length(); i++) {
                JSONObject item = profiles.optJSONObject(i);
                if (item != null && profileId.equals(item.optString("id"))) profile = item;
            }
        }
        if (profile == null) return;
        // A catalog entry that says this profile has a PIN, but didn't include the hash, must not be written back.
        if (profile.optBoolean("hasPin") && profile.optString("pinHash").isEmpty()) return;
        JSONObject bundle = NativeApp.api().bundle(profileId);
        if (bundle.optInt("version") != 1) return;
        long seen = bundle.optLong("updatedAt");
        apply(bundle, pending);
        JSONObject latest = NativeApp.api().bundle(profileId);
        if (latest.optLong("updatedAt") != seen && latest.optInt("version") == 1) {
            bundle = latest;
            apply(bundle, pending);
        }
        bundle.put("updatedAt", System.currentTimeMillis());
        NativeApp.api().putProfile(profileId, profile.optString("name", "未命名"), profile.optString("pinHash"), bundle);
    }

    private static void apply(JSONObject bundle, JSONArray pending) throws org.json.JSONException, IOException {
        JSONArray history = bundle.optJSONArray("history");
        if (history == null) {
            history = new JSONArray();
            bundle.put("history", history);
        }
        JSONArray progress = bundle.optJSONArray("progress");
        if (progress == null) {
            progress = new JSONArray();
            bundle.put("progress", progress);
        }
        for (int n = 0; n < pending.length(); n++) {
            JSONObject row = pending.optJSONObject(n);
            if (row == null || row.optString("vodId").isEmpty() || row.optString("sourceKey").isEmpty()) continue;
            int found = -1;
            for (int i = 0; i < history.length(); i++) {
                JSONObject item = history.optJSONObject(i);
                if (item != null && row.optString("sourceKey").equals(item.optString("sourceKey")) && row.optString("vodId").equals(item.optString("vodId"))) {
                    found = i;
                }
            }
            JSONObject target = found >= 0 ? history.optJSONObject(found) : new JSONObject();
            if (target == null) target = new JSONObject();
            copy(row, target);
            if (found < 0) history.put(target);
            else history.put(found, target);
            String localKey = row.optString("sourceKey") + "_" + row.optString("vodId") + "_" + row.optInt("episodeIndex");
            int progressAt = -1;
            for (int i = 0; i < progress.length(); i++) {
                JSONObject item = progress.optJSONObject(i);
                if (item != null && localKey.equals(item.optString("localKey"))) progressAt = i;
            }
            JSONObject point = new JSONObject();
            point.put("localKey", localKey);
            point.put("position", row.optInt("playbackPosition"));
            point.put("duration", row.optInt("duration"));
            point.put("updatedAt", row.optLong("timestamp"));
            if (progressAt < 0) progress.put(point);
            else progress.put(progressAt, point);
        }
    }

    private static void copy(JSONObject from, JSONObject to) throws IOException {
        try {
            String[] keys = {"sourceKey", "sourceUrl", "vodId", "title", "pic", "episodeIndex", "totalEpisodes", "playbackPosition", "duration", "timestamp"};
            for (String key : keys) {
                if (from.has(key)) to.put(key, from.get(key));
            }
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        }
    }

    private static JSONArray overlay(String raw) {
        try {
            return new JSONArray(raw);
        } catch (org.json.JSONException e) {
            return new JSONArray();
        }
    }
}
