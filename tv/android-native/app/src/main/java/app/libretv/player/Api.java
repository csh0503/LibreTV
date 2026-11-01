package app.libretv.player;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public final class Api {
    public static final String BASE = "https://libre-tv-dusky-delta.vercel.app";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final String SOURCES = "default_sources";

    private final CookieStore cookies;
    private final OkHttpClient client;
    private final OkHttpClient playback;

    public Api(Context context) {
        cookies = new CookieStore(context);
        client = new OkHttpClient.Builder()
                .cookieJar(cookies)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .callTimeout(70, TimeUnit.SECONDS)
                .build();
        playback = client.newBuilder()
                .callTimeout(0, TimeUnit.SECONDS)
                .addInterceptor(new Playlist.Rewriter())
                .build();
    }

    public OkHttpClient http() {
        return client;
    }

    /** Player client: media playlists have the same ad groups removed as the website. */
    public OkHttpClient playbackHttp() {
        return playback;
    }

    public CookieStore cookies() {
        return cookies;
    }

    public JSONObject status() throws IOException {
        JSONObject body = get("/api/status", false);
        JSONArray sources = body.optJSONArray("defaultSources");
        if (sources != null) cookies.prefs().edit().putString(SOURCES, sources.toString()).apply();
        return body;
    }

    public JSONArray sources() {
        try {
            return new JSONArray(cookies.prefs().getString(SOURCES, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    public void login(String password) throws IOException {
        JSONObject body = new JSONObject();
        try {
            body.put("password", password);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        JSONObject result = post("/api/auth", body, false);
        if (!result.optBoolean("success")) {
            throw new IOException(result.optString("error", "登录失败"));
        }
    }

    public void logout() throws IOException {
        try {
            execute(new Request.Builder().url(BASE + "/api/auth").delete().build(), false);
        } finally {
            cookies.clear();
        }
    }

    public JSONArray profiles() throws IOException {
        return get("/api/profile-sync", true).optJSONArray("profiles");
    }

    public JSONObject bundle(String id) throws IOException {
        return get("/api/profile-sync?id=" + url(id), true);
    }

    public void putProfile(String id, String name, String pinHash, JSONObject bundle) throws IOException {
        JSONObject body = new JSONObject();
        try {
            body.put("id", id);
            body.put("name", name);
            if (pinHash != null && !pinHash.isEmpty()) body.put("pinHash", pinHash);
            body.put("bundle", bundle);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        Request request = new Request.Builder()
                .url(BASE + "/api/profile-sync")
                .put(RequestBody.create(body.toString(), JSON))
                .build();
        execute(request, true);
    }

    public JSONArray shelves(String ids) throws IOException {
        JSONArray rows = get("/api/shelves?ids=" + url(ids), true).optJSONArray("shelves");
        return rows == null ? new JSONArray() : rows;
    }

    /** Calls onItem on the worker thread as each source finishes. Returns how many sources failed. */
    public int searchEach(String query, java.util.function.Consumer<JSONObject> onItem) throws IOException {
        JSONArray sources = sources();
        if (sources.length() == 0) throw new IOException("没有片源。先连上站点再搜索");
        JSONObject body = new JSONObject();
        try {
            body.put("wd", query);
            body.put("sources", sources);
            body.put("filterAdult", true);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        Request request = new Request.Builder()
                .url(BASE + "/api/search?stream=1")
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        int failures = 0;
        try (Response response = client.newCall(request).execute()) {
            if (response.code() == 401) throw new AuthException();
            if (!response.isSuccessful() || response.body() == null) throw new IOException("搜索失败 (" + response.code() + ")");
            okio.BufferedSource source = response.body().source();
            while (!source.exhausted()) {
                String line = source.readUtf8Line();
                if (line == null) break;
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.charAt(0) != '{') continue;
                JSONObject event;
                try {
                    event = new JSONObject(trimmed);
                } catch (JSONException e) {
                    continue;
                }
                if (!"source".equals(event.optString("type"))) continue;
                if (!event.optBoolean("ok")) failures += 1;
                JSONArray list = event.optJSONArray("list");
                if (list == null) continue;
                for (int i = 0; i < list.length(); i++) {
                    JSONObject item = list.optJSONObject(i);
                    if (item != null) onItem.accept(item);
                }
            }
        }
        return failures;
    }

    public JSONArray search(String query) throws IOException {
        JSONArray sources = sources();
        if (sources.length() == 0) throw new IOException("没有片源。先连上站点再搜索");
        JSONObject body = new JSONObject();
        try {
            body.put("wd", query);
            body.put("sources", sources);
            body.put("filterAdult", true);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        JSONArray list = post("/api/search", body, true).optJSONArray("list");
        return list == null ? new JSONArray() : list;
    }

    public JSONObject detail(String vodId, JSONObject source) throws IOException {
        HttpUrl url = HttpUrl.parse(BASE + "/api/detail").newBuilder()
                .addQueryParameter("id", vodId)
                .addQueryParameter("source", source.toString())
                .build();
        return execute(new Request.Builder().url(url).get().build(), true);
    }

    public JSONObject sourceFor(String key, String fallbackUrl) throws IOException {
        JSONArray sources = sources();
        for (int i = 0; i < sources.length(); i++) {
            JSONObject source = sources.optJSONObject(i);
            if (source != null && key != null && key.equals(source.optString("key"))) return source;
        }
        if (fallbackUrl == null || fallbackUrl.isEmpty()) throw new IOException("找不到这个片源");
        JSONObject made = new JSONObject();
        try {
            made.put("key", key == null || key.isEmpty() ? "history" : key);
            made.put("name", key == null || key.isEmpty() ? "历史" : key);
            made.put("url", fallbackUrl);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        return made;
    }

    public static boolean pinMatches(String profileId, String pinHash, String pin) {
        if (pinHash == null || pinHash.isEmpty()) return true;
        return pinHash.equals(sha256(profileId + ":" + (pin == null ? "" : pin)));
    }

    public static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private JSONObject get(String path, boolean session) throws IOException {
        return execute(new Request.Builder().url(BASE + path).get().build(), session);
    }

    private JSONObject post(String path, JSONObject body, boolean session) throws IOException {
        Request request = new Request.Builder()
                .url(BASE + path)
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        return execute(request, session);
    }

    private JSONObject execute(Request request, boolean session) throws IOException {
        try (Response response = client.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            JSONObject json;
            try {
                json = text.isEmpty() || text.charAt(0) != '{' ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                throw new IOException("服务器回应无法读取");
            }
            if (response.code() == 401 && session) throw new AuthException();
            if (!response.isSuccessful()) {
                throw new IOException(json.optString("error", "请求失败 (" + response.code() + ")"));
            }
            return json;
        }
    }

    private static String url(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            return value;
        }
    }

    public static final class AuthException extends IOException {
        public AuthException() {
            super("登录已过期");
        }
    }
}
