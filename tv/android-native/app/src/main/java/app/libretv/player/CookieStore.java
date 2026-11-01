package app.libretv.player;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;

/** Persists the LibreTV session cookie. The site password is never stored. */
public final class CookieStore implements CookieJar {
    private static final String PREFS = "libretv_native";
    private static final String KEY = "cookies";
    private final SharedPreferences prefs;
    private final List<Cookie> cookies = new ArrayList<>();

    public CookieStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        load();
    }

    public SharedPreferences prefs() {
        return prefs;
    }

    public synchronized boolean hasSession() {
        long now = System.currentTimeMillis();
        for (Cookie cookie : cookies) {
            if ("ltv_session".equals(cookie.name()) && cookie.expiresAt() > now) return true;
        }
        return false;
    }

    public synchronized void clear() {
        cookies.clear();
        prefs.edit().remove(KEY).apply();
    }

    @Override
    public synchronized void saveFromResponse(HttpUrl url, List<Cookie> incoming) {
        for (Cookie next : incoming) {
            cookies.removeIf(old -> old.name().equals(next.name()) && old.domain().equals(next.domain()) && old.path().equals(next.path()));
            cookies.add(next);
        }
        save();
    }

    @Override
    public synchronized List<Cookie> loadForRequest(HttpUrl url) {
        long now = System.currentTimeMillis();
        List<Cookie> matched = new ArrayList<>();
        boolean dropped = false;
        for (int i = cookies.size() - 1; i >= 0; i--) {
            Cookie cookie = cookies.get(i);
            if (cookie.expiresAt() <= now) {
                cookies.remove(i);
                dropped = true;
                continue;
            }
            if (cookie.matches(url)) matched.add(cookie);
        }
        if (dropped) save();
        return Collections.unmodifiableList(matched);
    }

    private void load() {
        String raw = prefs.getString(KEY, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                Cookie.Builder builder = new Cookie.Builder()
                        .name(item.getString("name"))
                        .value(item.getString("value"))
                        .path(item.optString("path", "/"))
                        .expiresAt(item.optLong("expires", Long.MAX_VALUE));
                if (item.optBoolean("hostOnly")) builder.hostOnlyDomain(item.getString("domain"));
                else builder.domain(item.getString("domain"));
                if (item.optBoolean("secure")) builder.secure();
                if (item.optBoolean("httpOnly")) builder.httpOnly();
                cookies.add(builder.build());
            }
        } catch (Exception ignored) {
            cookies.clear();
        }
    }

    private void save() {
        JSONArray array = new JSONArray();
        try {
            for (Cookie cookie : cookies) {
                JSONObject item = new JSONObject();
                item.put("name", cookie.name());
                item.put("value", cookie.value());
                item.put("domain", cookie.domain());
                item.put("path", cookie.path());
                item.put("expires", cookie.expiresAt());
                item.put("secure", cookie.secure());
                item.put("httpOnly", cookie.httpOnly());
                item.put("hostOnly", cookie.hostOnly());
                array.put(item);
            }
        } catch (Exception ignored) {
            return;
        }
        prefs.edit().putString(KEY, array.toString()).apply();
    }
}
