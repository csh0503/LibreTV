package app.libretv.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.HttpUrl;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * The website's playlist rules: read clarity from the master playlist,
 * and drop the same ad groups the web player drops.
 */
public final class Playlist {
    private static final Pattern EXTINF = Pattern.compile("^#EXTINF:([\\d.]+)");
    private static final Pattern BANDWIDTH = Pattern.compile("BANDWIDTH=(\\d+)");
    private static final Pattern RESOLUTION = Pattern.compile("RESOLUTION=\\d+x(\\d+)");
    private static final Pattern AD_URL = Pattern.compile("adjump|advert|/ads?/|%2fads?%2f", Pattern.CASE_INSENSITIVE);
    private static final int LEAD_AD_MAX_SECONDS = 90;
    private static final int LEAD_AD_MAX_SEGMENTS = 20;
    private static final int INTERSTITIAL_MAX_SECONDS = 30;
    private static final int INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;
    private static final int REPEATED_AD_MAX_SECONDS = 60;
    private static final int ODD_AD_MAX_SECONDS = 60;
    private static final int ODD_MIN_SEGMENTS = 30;
    private static final int ODD_MAX_GROUPS = 4;
    private static final int ODD_MAX_TOTAL_SECONDS = 180;

    private Playlist() {}

    public static final class Report {
        public final int height;
        public final boolean estimated;
        public final int adSeconds;
        public final boolean measured;

        Report(int height, boolean estimated, int adSeconds, boolean measured) {
            this.height = height;
            this.estimated = estimated;
            this.adSeconds = adSeconds;
            this.measured = measured;
        }

        public String label() {
            if (!measured) return "这路看不了清晰度";
            String quality = qualityName(height);
            if (estimated && !quality.isEmpty()) quality = "约" + quality;
            String ads = "";
            if (adSeconds > 0) ads = "已去广告 " + adSeconds + " 秒";
            else if (adSeconds == 0) ads = "无插入广告";
            if (quality.isEmpty()) return ads;
            if (ads.isEmpty()) return quality;
            return quality + " · " + ads;
        }

        public static String qualityName(int height) {
            if (height >= 2000) return "4K";
            if (height >= 1000) return "1080P";
            if (height >= 700) return "720P";
            if (height >= 450) return "480P";
            return height > 0 ? "标清" : "";
        }
    }

    public static Report probe(OkHttpClient raw, String episodeUrl) {
        Report cached = ProbeCache.get(episodeUrl);
        if (cached != null) return cached;
        Report report = measure(raw, episodeUrl);
        if (report.measured) ProbeCache.put(episodeUrl, report);
        return report;
    }

    private static Report measure(OkHttpClient raw, String episodeUrl) {
        if (episodeUrl == null || !episodeUrl.matches("(?i).*\\.m3u8(\\?.*)?$")) {
            return new Report(0, false, -1, false);
        }
        OkHttpClient client = raw.newBuilder().callTimeout(12, java.util.concurrent.TimeUnit.SECONDS).build();
        try {
            String playlistUrl = episodeUrl;
            String text = readPlaylist(client, playlistUrl);
            int height = 0;
            List<Variant> variants = master(text);
            if (!variants.isEmpty()) {
                Variant best = variants.get(0);
                for (Variant variant : variants) {
                    if (variant.height > best.height || (variant.height == best.height && variant.bandwidth > best.bandwidth)) {
                        best = variant;
                    }
                }
                height = best.height;
                HttpUrl resolved = HttpUrl.parse(playlistUrl);
                if (resolved != null) {
                    HttpUrl next = resolved.resolve(best.uri);
                    if (next != null) {
                        playlistUrl = next.toString();
                        text = readPlaylist(client, playlistUrl);
                    }
                }
            }
            if (text.contains("#EXT-X-STREAM-INF")) return new Report(height, false, -1, height > 0);
            double original = duration(text);
            String cleaned = stripAds(text);
            int adSeconds = Math.max(0, (int) Math.round(original - duration(cleaned)));
            boolean estimated = false;
            if (height <= 0) {
                String sample = middleSegment(cleaned.isEmpty() ? text : cleaned);
                if (sample != null) {
                    HttpUrl base = HttpUrl.parse(playlistUrl);
                    HttpUrl segment = base == null ? null : base.resolve(sample);
                    double sampleSeconds = middleDuration(cleaned.isEmpty() ? text : cleaned);
                    int bytes = segment == null ? 0 : headSize(client, segment.toString());
                    if (bytes > 0 && sampleSeconds > 0) {
                        int kbps = (int) Math.round((bytes * 8.0) / sampleSeconds / 1000.0);
                        height = heightFromKbps(kbps);
                        estimated = height > 0;
                    }
                }
            }
            return new Report(height, estimated, adSeconds, true);
        } catch (Exception e) {
            return new Report(0, false, -1, false);
        }
    }

    public static String stripAds(String content) {
        if (content == null || content.isEmpty()) return "";
        return stripLeadingDisc(stripLead(stripInterstitial(stripMarked(stripOdd(stripRepeated(content))))));
    }

    public static final class Rewriter implements Interceptor {
        @Override
        public Response intercept(Chain chain) throws IOException {
            Response response = chain.proceed(chain.request());
            ResponseBody body = response.body();
            if (body == null || !response.isSuccessful()) return response;
            String url = response.request().url().toString().toLowerCase();
            String type = response.header("Content-Type", "").toLowerCase();
            if (!url.contains("m3u8") && !type.contains("mpegurl") && !type.contains("m3u8")) return response;
            MediaType media = body.contentType();
            String text = body.string();
            if (!text.trim().startsWith("#EXTM3U") || text.contains("#EXT-X-STREAM-INF")) {
                return response.newBuilder().body(ResponseBody.create(text, media)).build();
            }
            return response.newBuilder().body(ResponseBody.create(stripAds(text), media)).build();
        }
    }

    private static String readPlaylist(OkHttpClient client, String url) throws IOException {
        String text = get(client, url);
        if (text.trim().startsWith("#EXTM3U")) return text;
        String proxied = get(client, Api.BASE + "/api/proxy?url=" + java.net.URLEncoder.encode(url, "UTF-8"));
        if (!proxied.trim().startsWith("#EXTM3U")) throw new IOException("不是播放列表");
        return proxied;
    }

    private static String get(OkHttpClient client, String url) throws IOException {
        Request request = new Request.Builder().url(url).header("User-Agent", PlayerActivity.UA).build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("HTTP " + response.code());
            return response.body().string();
        }
    }

    private static int headSize(OkHttpClient client, String url) {
        Request request = new Request.Builder().url(url).head().header("User-Agent", PlayerActivity.UA).build();
        try (Response response = client.newCall(request).execute()) {
            String len = response.header("Content-Length");
            if (!response.isSuccessful() || len == null) return 0;
            return Integer.parseInt(len);
        } catch (Exception e) {
            return 0;
        }
    }

    private static int heightFromKbps(int kbps) {
        if (kbps >= 2500) return 1080;
        if (kbps >= 1200) return 720;
        if (kbps >= 600) return 480;
        return kbps > 0 ? 360 : 0;
    }

    private static final class Variant {
        final String uri;
        final int bandwidth;
        final int height;

        Variant(String uri, int bandwidth, int height) {
            this.uri = uri;
            this.bandwidth = bandwidth;
            this.height = height;
        }
    }

    private static List<Variant> master(String content) {
        String[] lines = lines(content);
        List<Variant> out = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            if (!lines[i].trim().startsWith("#EXT-X-STREAM-INF")) continue;
            String attrs = lines[i];
            int bandwidth = number(BANDWIDTH, attrs);
            int height = number(RESOLUTION, attrs);
            String uri = "";
            for (int j = i + 1; j < lines.length; j++) {
                String line = lines[j].trim();
                if (!line.isEmpty() && !line.startsWith("#")) {
                    uri = line;
                    break;
                }
            }
            if (!uri.isEmpty()) out.add(new Variant(uri, bandwidth, height));
        }
        return out;
    }

    private static int number(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return 0;
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static double duration(String content) {
        double seconds = 0;
        for (String line : lines(content)) {
            Matcher matcher = EXTINF.matcher(line.trim());
            if (matcher.find()) seconds += Double.parseDouble(matcher.group(1));
        }
        return seconds;
    }

    private static String middleSegment(String content) {
        List<String> uris = new ArrayList<>();
        for (String line : lines(content)) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty() && !trimmed.startsWith("#")) uris.add(trimmed);
        }
        if (uris.isEmpty()) return null;
        return uris.get(uris.size() / 2);
    }

    private static double middleDuration(String content) {
        List<Double> durations = new ArrayList<>();
        double pending = 0;
        for (String line : lines(content)) {
            String trimmed = line.trim();
            Matcher matcher = EXTINF.matcher(trimmed);
            if (matcher.find()) {
                pending = Double.parseDouble(matcher.group(1));
                continue;
            }
            if (!trimmed.isEmpty() && !trimmed.startsWith("#")) durations.add(pending);
        }
        if (durations.isEmpty()) return 0;
        return durations.get(durations.size() / 2);
    }

    private static String[] lines(String content) {
        return content.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
    }

    private static boolean disc(String line) {
        return line.trim().equals("#EXT-X-DISCONTINUITY");
    }

    private static boolean segment(String line) {
        String trimmed = line.trim();
        return !trimmed.isEmpty() && !trimmed.startsWith("#");
    }

    private static String join(List<String> lines) {
        return String.join("\n", lines);
    }

    private static String stripLead(String content) {
        if (content.isEmpty()) return "";
        List<String> lines = new ArrayList<>(Arrays.asList(lines(content)));
        List<Integer> discs = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++) if (disc(lines.get(i))) discs.add(i);
        if (discs.size() >= 4) {
            int leadSize = groupSize(lines, discs.get(0) + 1, discs.get(1));
            List<Integer> others = new ArrayList<>();
            for (int g = 1; g < discs.size(); g++) {
                int end = g + 1 < discs.size() ? discs.get(g + 1) : lines.size();
                others.add(groupSize(lines, discs.get(g) + 1, end));
            }
            List<Integer> sorted = new ArrayList<>(others);
            Collections.sort(sorted);
            int median = sorted.get(sorted.size() / 2);
            if (Math.abs(leadSize - median) <= Math.max(3, median * 0.5)) return content;
        }
        if (discs.isEmpty()) return content;
        int firstDisc = discs.get(0);
        for (int i = 0; i < firstDisc; i++) if (segment(lines.get(i))) return content;
        Integer nextDisc = null;
        for (int index : discs) if (index > firstDisc) { nextDisc = index; break; }
        if (nextDisc == null) return content;
        double seconds = 0;
        int count = 0;
        for (int i = firstDisc + 1; i < nextDisc; i++) {
            Matcher matcher = EXTINF.matcher(lines.get(i).trim());
            if (matcher.find()) seconds += Double.parseDouble(matcher.group(1));
            else if (segment(lines.get(i))) count += 1;
        }
        if (count == 0 || count > LEAD_AD_MAX_SEGMENTS) return content;
        if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return content;
        List<String> kept = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++) {
            if (i < firstDisc || i >= nextDisc) {
                kept.add(lines.get(i));
                continue;
            }
            String trimmed = lines.get(i).trim();
            if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) kept.add(lines.get(i));
        }
        List<String> out = new ArrayList<>();
        boolean seen = false;
        for (String line : kept) {
            if (!seen && disc(line)) continue;
            if (segment(line)) seen = true;
            out.add(line);
        }
        return join(out);
    }

    private static int groupSize(List<String> lines, int from, int to) {
        int count = 0;
        for (int i = from; i < to && i < lines.size(); i++) if (segment(lines.get(i))) count += 1;
        return count;
    }

    private static String stripMarked(String content) {
        if (content.isEmpty()) return "";
        List<String> lines = new ArrayList<>(Arrays.asList(lines(content)));
        boolean[] drop = new boolean[lines.size()];
        boolean any = false;
        int i = 0;
        while (i < lines.size()) {
            if (!disc(lines.get(i))) { i += 1; continue; }
            int j = i + 1;
            int count = 0;
            boolean allAd = true;
            while (j < lines.size() && !disc(lines.get(j))) {
                if (segment(lines.get(j))) {
                    count += 1;
                    if (!AD_URL.matcher(lines.get(j)).find()) allAd = false;
                }
                j += 1;
            }
            if (count > 0 && allAd) {
                drop[i] = true;
                any = true;
                for (int k = i + 1; k < j; k++) {
                    String trimmed = lines.get(k).trim();
                    if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) continue;
                    drop[k] = true;
                }
            }
            i = j;
        }
        return any ? keep(lines, drop) : content;
    }

    private static final class Group {
        final int start;
        final int end;
        final int discLine;
        final double seconds;
        final int count;

        Group(int start, int end, int discLine, double seconds, int count) {
            this.start = start;
            this.end = end;
            this.discLine = discLine;
            this.seconds = seconds;
            this.count = count;
        }
    }

    private static List<Group> scan(List<String> lines) {
        List<Integer> discs = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++) if (disc(lines.get(i))) discs.add(i);
        List<Integer> bounds = new ArrayList<>();
        bounds.add(0);
        bounds.addAll(discs);
        bounds.add(lines.size());
        List<Group> groups = new ArrayList<>();
        for (int k = 0; k < bounds.size() - 1; k++) {
            int start = k == 0 ? 0 : bounds.get(k) + 1;
            int end = bounds.get(k + 1);
            double seconds = 0;
            int count = 0;
            for (int i = start; i < end; i++) {
                Matcher matcher = EXTINF.matcher(lines.get(i).trim());
                if (matcher.find()) seconds += Double.parseDouble(matcher.group(1));
                else if (segment(lines.get(i))) count += 1;
            }
            groups.add(new Group(start, end, k == 0 ? -1 : bounds.get(k), seconds, count));
        }
        return groups;
    }

    private static String stripInterstitial(String content) {
        if (content.isEmpty()) return "";
        List<String> lines = new ArrayList<>(Arrays.asList(lines(content)));
        List<Group> groups = scan(lines);
        boolean[] drop = new boolean[lines.size()];
        boolean any = false;
        for (int k = 1; k < groups.size(); k++) {
            Group group = groups.get(k);
            Group prev = groups.get(k - 1);
            Group next = k + 1 < groups.size() ? groups.get(k + 1) : null;
            if (group.count == 0 || group.discLine < 0) continue;
            if (group.seconds <= 0 || group.seconds > INTERSTITIAL_MAX_SECONDS) continue;
            if (prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
            if (next == null || next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
            drop[group.discLine] = true;
            any = true;
            for (int i = group.start; i < group.end; i++) {
                String trimmed = lines.get(i).trim();
                if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) continue;
                drop[i] = true;
            }
        }
        return any ? keep(lines, drop) : content;
    }

    private static String stripRepeated(String content) {
        if (content.isEmpty()) return "";
        List<String> lines = new ArrayList<>(Arrays.asList(lines(content)));
        List<Group> groups = scan(lines);
        if (groups.size() < 2) return content;
        List<String> keys = new ArrayList<>();
        Map<String, Integer> counts = new HashMap<>();
        for (Group group : groups) {
            StringBuilder key = new StringBuilder();
            for (int i = group.start; i < group.end; i++) {
                if (!segment(lines.get(i))) continue;
                if (key.length() > 0) key.append('\n');
                key.append(lines.get(i).trim());
            }
            String value = key.toString();
            keys.add(value);
            if (!value.isEmpty()) counts.put(value, counts.getOrDefault(value, 0) + 1);
        }
        boolean[] drop = new boolean[lines.size()];
        boolean any = false;
        for (int k = 0; k < groups.size(); k++) {
            Group group = groups.get(k);
            if (counts.getOrDefault(keys.get(k), 0) < 2) continue;
            if (group.count < 2 || group.seconds <= 0 || group.seconds > REPEATED_AD_MAX_SECONDS) continue;
            if (group.discLine >= 0) drop[group.discLine] = true;
            any = true;
            for (int i = group.start; i < group.end; i++) {
                String trimmed = lines.get(i).trim();
                if (segment(lines.get(i)) || trimmed.startsWith("#EXTINF") || trimmed.startsWith("#EXT-X-BYTERANGE")) drop[i] = true;
            }
        }
        return any ? keep(lines, drop) : content;
    }

    private static String stripOdd(String content) {
        if (content.isEmpty()) return "";
        List<String> lines = new ArrayList<>(Arrays.asList(lines(content)));
        List<Group> groups = scan(lines);
        if (groups.size() < 3) return content;
        List<double[]> durations = new ArrayList<>();
        for (int k = 0; k < groups.size(); k++) {
            Group group = groups.get(k);
            double pending = 0;
            for (int i = group.start; i < group.end; i++) {
                Matcher matcher = EXTINF.matcher(lines.get(i).trim());
                if (matcher.find()) pending = Double.parseDouble(matcher.group(1));
                else if (segment(lines.get(i))) durations.add(new double[]{k, pending});
            }
        }
        if (durations.size() < ODD_MIN_SEGMENTS) return content;
        Map<String, Integer> counts = new HashMap<>();
        for (double[] item : durations) {
            String key = String.format(java.util.Locale.US, "%.2f", item[1]);
            counts.put(key, counts.getOrDefault(key, 0) + 1);
        }
        double mode = 0;
        int modeCount = 0;
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            if (entry.getValue() > modeCount) {
                mode = Double.parseDouble(entry.getKey());
                modeCount = entry.getValue();
            }
        }
        if (modeCount / (double) durations.size() < 0.9) return content;
        boolean[] odd = new boolean[groups.size()];
        for (int i = 0; i < durations.size(); i++) {
            if (i == durations.size() - 1) continue;
            if (Math.abs(durations.get(i)[1] - mode) > 0.05) odd[(int) durations.get(i)[0]] = true;
        }
        List<Group> targets = new ArrayList<>();
        double total = 0;
        for (int k = 0; k < groups.size(); k++) {
            Group group = groups.get(k);
            if (!odd[k]) continue;
            if (group.count > 0 && group.seconds > 0 && group.seconds <= ODD_AD_MAX_SECONDS) {
                targets.add(group);
                total += group.seconds;
            }
        }
        if (targets.size() > ODD_MAX_GROUPS || total > ODD_MAX_TOTAL_SECONDS) return content;
        boolean[] drop = new boolean[lines.size()];
        boolean any = false;
        for (Group group : targets) {
            if (group.discLine >= 0) drop[group.discLine] = true;
            any = true;
            for (int i = group.start; i < group.end; i++) {
                String trimmed = lines.get(i).trim();
                if (segment(lines.get(i)) || trimmed.startsWith("#EXTINF") || trimmed.startsWith("#EXT-X-BYTERANGE")) drop[i] = true;
            }
        }
        return any ? keep(lines, drop) : content;
    }

    private static String stripLeadingDisc(String content) {
        String[] lines = lines(content);
        int first = -1;
        for (int i = 0; i < lines.length; i++) if (segment(lines[i])) { first = i; break; }
        if (first <= 0) return content;
        List<String> kept = new ArrayList<>();
        boolean changed = false;
        for (int i = 0; i < lines.length; i++) {
            if (i < first && disc(lines[i])) { changed = true; continue; }
            kept.add(lines[i]);
        }
        return changed ? join(kept) : content;
    }

    private static final class ProbeCache {
        private static final String KEY = "probe_cache";
        private static final long TTL = 6L * 60L * 60L * 1000L;

        static Report get(String url) {
            if (url == null || url.isEmpty()) return null;
            try {
                JSONObject all = all();
                JSONObject hit = all.optJSONObject(url);
                if (hit == null || System.currentTimeMillis() - hit.optLong("t") > TTL) return null;
                return new Report(hit.optInt("h"), hit.optBoolean("e"), hit.optInt("a"), true);
            } catch (Exception ignored) {
                return null;
            }
        }

        static void put(String url, Report report) {
            try {
                JSONObject all = all();
                long now = System.currentTimeMillis();
                JSONArray names = all.names();
                if (names != null) {
                    for (int i = 0; i < names.length(); i++) {
                        String name = names.optString(i);
                        JSONObject hit = all.optJSONObject(name);
                        if (hit == null || now - hit.optLong("t") > TTL) all.remove(name);
                    }
                }
                JSONObject hit = new JSONObject();
                hit.put("h", report.height);
                hit.put("e", report.estimated);
                hit.put("a", report.adSeconds);
                hit.put("t", now);
                all.put(url, hit);
                NativeApp.api().cookies().prefs().edit().putString(KEY, all.toString()).apply();
            } catch (Exception ignored) {
                // 記不住就下次再測。
            }
        }

        private static JSONObject all() {
            try {
                return new JSONObject(NativeApp.api().cookies().prefs().getString(KEY, "{}"));
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    private static String keep(List<String> lines, boolean[] drop) {
        List<String> kept = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++) if (!drop[i]) kept.add(lines.get(i));
        return join(kept);
    }
}
