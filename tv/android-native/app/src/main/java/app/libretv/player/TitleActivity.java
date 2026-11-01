package app.libretv.player;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Poster card, source list with clarity and ad labels, then episode buttons. */
public class TitleActivity extends Activity {
    public static final String TITLE = "title";
    public static final String IMAGE = "image";
    public static final String SUB = "sub";
    public static final String VOD_ID = "vod_id";
    public static final String SOURCE = "source";
    public static final String EPISODE = "episode";
    public static final String POSITION = "position";

    private final List<Line> sources = new ArrayList<>();
    private final List<Line> others = new ArrayList<>();
    private final ExecutorService probes = Executors.newFixedThreadPool(8);
    private RecyclerView sourceList;
    private RecyclerView episodeList;
    private TextView message;
    private TextView episodeLabel;
    private String showTitle = "";
    private String resumeVod = "";
    private String resumeSource = "";
    private int resumeEpisode;
    private int resumePosition;
    private int selected = -1;
    private int detailSeq;
    private JSONArray episodes = new JSONArray();
    private JSONArray names = new JSONArray();
    private boolean askedFocus;
    private boolean userPicked;
    private final android.os.Handler rankHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable rankTask = this::applyRank;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_title);
        showTitle = text(TITLE);
        resumeVod = text(VOD_ID);
        resumeSource = text(SOURCE);
        resumeEpisode = getIntent().getIntExtra(EPISODE, 0);
        resumePosition = getIntent().getIntExtra(POSITION, 0);
        ((TextView) findViewById(R.id.title)).setText(showTitle);
        ((TextView) findViewById(R.id.meta)).setText(text(SUB));
        message = findViewById(R.id.message);
        episodeLabel = findViewById(R.id.episode_label);
        Images.load(findViewById(R.id.poster), text(IMAGE));
        sourceList = findViewById(R.id.sources);
        sourceList.setLayoutManager(new LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false));
        sourceList.setAdapter(new SourceAdapter());
        episodeList = findViewById(R.id.episodes);
        episodeList.setLayoutManager(new GridLayoutManager(this, 8));
        episodeList.setAdapter(new EpisodeAdapter());
        message.setText("正在查找片源，清晰度和广告会逐个出来");
        if (!resumeVod.isEmpty() && !resumeSource.isEmpty()) {
            Line known = new Line(showTitle, "上次看到的源", text(SUB), resumeVod, resumeSource, "");
            known.label = "正在分析清晰度和广告…";
            sources.add(known);
            sourceList.getAdapter().notifyItemInserted(0);
            select(0);
        }
        if (showTitle.isEmpty()) {
            message.setText("没有片名");
            return;
        }
        NativeApp.streamSearch(this, showTitle, this::consider, this::finishSearch, e -> message.setText(e.getMessage()));
    }

    private void consider(JSONObject item) {
        String name = item.optString("name");
        if (name.isEmpty()) return;
        String vod = item.optString("vodId");
        String sourceJson = Open.sourceJson(item);
        if (vod.isEmpty() || sourceJson.isEmpty()) return;
        Line line = new Line(name, item.optString("sourceName", "片源"), remarks(item), vod, sourceJson, item.optString("firstEpisode"));
        if (find(sources, line) >= 0 || find(others, line) >= 0) return;
        if (sameShow(name)) {
            int known = resumeIndex(vod, sourceJson);
            if (known >= 0) {
                Line existing = sources.get(known);
                if (existing.firstEpisode.isEmpty()) existing.firstEpisode = line.firstEpisode;
                existing.show = name;
                existing.sourceName = line.sourceName;
                existing.remarks = line.remarks;
                probe(existing);
                sourceList.getAdapter().notifyItemChanged(known);
                return;
            }
            sources.add(line);
            int index = sources.size() - 1;
            if (index >= 8) line.label = "";
            sourceList.getAdapter().notifyItemInserted(index);
            if (index < 8) probe(line);
            if (selected < 0) select(index);
            message.setText("片源 " + sources.size() + " 个，清晰度还在分析");
            focusSourcesOnce();
        } else if (others.size() < 16) {
            others.add(line);
        }
        String pic = item.optString("pic");
        if (!pic.isEmpty() && text(IMAGE).isEmpty()) Images.load(findViewById(R.id.poster), pic);
    }

    private void finishSearch(int failures) {
        if (sources.isEmpty()) {
            for (Line line : others) {
                if (sources.size() >= 12) break;
                sources.add(line);
                sourceList.getAdapter().notifyItemInserted(sources.size() - 1);
                probe(line);
            }
            if (selected < 0 && !sources.isEmpty()) select(0);
        }
        if (sources.isEmpty()) message.setText("暂无片源");
        else if (failures > 0) message.setText("片源 " + sources.size() + " 个 · " + failures + " 个源没有回应");
        else message.setText("片源 " + sources.size() + " 个");
        focusSourcesOnce();
    }

    private void select(int index) {
        int previous = selected;
        selected = index;
        if (previous >= 0) sourceList.getAdapter().notifyItemChanged(previous);
        sourceList.getAdapter().notifyItemChanged(index);
        Line line = sources.get(index);
        if (line.label.isEmpty()) line.label = "正在分析清晰度和广告…";
        probe(line);
        episodeLabel.setText("选集 · " + line.sourceName);
        int seq = ++detailSeq;
        episodes = new JSONArray();
        names = new JSONArray();
        episodeList.getAdapter().notifyDataSetChanged();
        NativeApp.io(this, () -> NativeApp.api().detail(line.vodId, new JSONObject(line.sourceJson)), detail -> {
            if (seq != detailSeq) return;
            episodes = detail.optJSONArray("episodes");
            if (episodes == null) episodes = new JSONArray();
            names = detail.optJSONArray("episodeNames");
            if (names == null) names = new JSONArray();
            episodeList.getAdapter().notifyDataSetChanged();
            if (episodes.length() == 0) message.setText("这个源没有剧集，换一个片源");
            String listed = episodes.optString(0);
            if (listed.contains("m3u8") && !line.firstEpisode.contains("m3u8")) {
                line.firstEpisode = listed;
                line.probed = false;
                line.probing = false;
                probe(line);
            }
            int focus = sameResume(line) ? resumeEpisode : 0;
            if (focus >= 0 && focus < episodes.length()) episodeList.scrollToPosition(focus);
        }, e -> {
            if (seq == detailSeq) message.setText(e.getMessage());
        });
    }

    private void probe(Line line) {
        if (line.firstEpisode.isEmpty() || line.probing || line.probed) return;
        line.probing = true;
        probes.execute(() -> {
            Playlist.Report report = Playlist.probe(NativeApp.api().http(), line.firstEpisode);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                line.probing = false;
                line.probed = report.measured;
                line.report = report;
                line.label = report.label();
                int index = sources.indexOf(line);
                if (index >= 0 && sourceList.getAdapter() != null) sourceList.getAdapter().notifyItemChanged(index);
                scheduleRank();
            });
        });
    }

    private void play(int index) {
        String url = episodes.optString(index);
        if (url.isEmpty()) {
            message.setText("这一集没有地址");
            return;
        }
        Line line = selected >= 0 && selected < sources.size() ? sources.get(selected) : null;
        String label = names.optString(index);
        if (label.isEmpty()) label = "第 " + (index + 1) + " 集";
        int position = line != null && sameResume(line) && index == resumeEpisode ? resumePosition : 0;
        JSONObject watch = new JSONObject();
        try {
            watch.put("title", showTitle);
            watch.put("vodId", line == null ? "" : line.vodId);
            watch.put("pic", text(IMAGE));
            watch.put("episodeIndex", index);
            watch.put("totalEpisodes", episodes.length());
            if (line != null) {
                JSONObject source = new JSONObject(line.sourceJson);
                watch.put("sourceKey", source.optString("key"));
                watch.put("sourceUrl", source.optString("url"));
            }
            watch.put("episodes", episodes);
            watch.put("episodeNames", names);
        } catch (org.json.JSONException ignored) {
            watch = null;
        }
        Open.play(this, showTitle + " · " + label, url, position, watch);
    }

    private boolean sameShow(String name) {
        return name.equals(showTitle) || WorkKey.same(name, showTitle);
    }

    private int resumeIndex(String vod, String sourceJson) {
        for (int i = 0; i < sources.size(); i++) {
            Line line = sources.get(i);
            if (line.vodId.equals(vod) && sameSource(line.sourceJson, sourceJson)) return i;
        }
        return -1;
    }

    private boolean sameResume(Line line) {
        return line.vodId.equals(resumeVod) && sameSource(line.sourceJson, resumeSource);
    }

    private static boolean sameSource(String a, String b) {
        if (a == null || b == null) return false;
        if (a.equals(b)) return true;
        try {
            JSONObject left = new JSONObject(a);
            JSONObject right = new JSONObject(b);
            String key = left.optString("key");
            return !key.isEmpty() && key.equals(right.optString("key")) && left.optString("url").equals(right.optString("url"));
        } catch (org.json.JSONException e) {
            return false;
        }
    }

    private static int find(List<Line> list, Line line) {
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).vodId.equals(line.vodId) && list.get(i).sourceJson.equals(line.sourceJson)) return i;
        }
        return -1;
    }

    private void scheduleRank() {
        rankHandler.removeCallbacks(rankTask);
        rankHandler.postDelayed(rankTask, 400);
    }

    /** Move the highlight to the best measured source unless this visit is a resume or the user already chose. */
    private void applyRank() {
        if (sources.isEmpty() || sourceList.getAdapter() == null) return;
        Line best = sources.get(0);
        for (int i = 1; i < sources.size(); i++) {
            if (prefer(sources.get(i), best)) best = sources.get(i);
        }
        Line previous = null;
        for (Line line : sources) {
            if (line.recommended) previous = line;
            line.recommended = false;
        }
        boolean measured = best.probed && best.report != null && best.report.measured;
        if (measured) best.recommended = true;
        Line current = selected >= 0 && selected < sources.size() ? sources.get(selected) : null;
        boolean locked = userPicked || (current != null && sameResume(current));
        if (previous != best) {
            int oldIndex = previous == null ? -1 : sources.indexOf(previous);
            int newIndex = sources.indexOf(best);
            if (oldIndex >= 0) sourceList.getAdapter().notifyItemChanged(oldIndex);
            if (newIndex >= 0 && newIndex != oldIndex) sourceList.getAdapter().notifyItemChanged(newIndex);
        }
        if (!locked && best.recommended && current != best) select(sources.indexOf(best));
    }

    private static boolean prefer(Line candidate, Line incumbent) {
        int fail = Integer.compare(SourceRank.failing(candidate.report, candidate.probed), SourceRank.failing(incumbent.report, incumbent.probed));
        if (fail != 0) return fail < 0;
        int tier = Integer.compare(SourceRank.tier(candidate.report, candidate.probed), SourceRank.tier(incumbent.report, incumbent.probed));
        if (tier != 0) return tier > 0;
        int episodes = Integer.compare(SourceRank.episodeCount(candidate.remarks), SourceRank.episodeCount(incumbent.remarks));
        if (episodes != 0) return episodes > 0;
        return SourceRank.ads(candidate.report) < SourceRank.ads(incumbent.report);
    }

    private void focusSourcesOnce() {
        if (askedFocus || sources.isEmpty()) return;
        askedFocus = true;
        sourceList.post(() -> {
            RecyclerView.ViewHolder holder = sourceList.findViewHolderForAdapterPosition(Math.max(selected, 0));
            if (holder != null) holder.itemView.requestFocus();
            else sourceList.requestFocus();
        });
    }

    private static String remarks(JSONObject item) {
        String text = item.optString("remarks");
        String year = item.optString("year");
        int count = item.optInt("episodeCount");
        if (!year.isEmpty()) text = text.isEmpty() ? year : text + " · " + year;
        if (count > 0) text = text.isEmpty() ? count + " 集" : text + " · " + count + " 集";
        return text;
    }

    private static String episodeNumber(String raw, int position) {
        String number = String.valueOf(position + 1);
        String padded = position < 9 ? "0" + number : number;
        String compact = raw.replace(" ", "");
        if (compact.isEmpty() || compact.equals(number) || compact.equals("第" + number + "集") || compact.equals("第" + padded + "集")) {
            return number;
        }
        return raw;
    }

    private String text(String key) {
        String value = getIntent().getStringExtra(key);
        return value == null ? "" : value;
    }

    @Override
    protected void onDestroy() {
        probes.shutdownNow();
        rankHandler.removeCallbacks(rankTask);
        super.onDestroy();
    }

    private static final class Line {
        String show;
        String sourceName;
        String remarks;
        final String vodId;
        final String sourceJson;
        String firstEpisode;
        String label = "正在分析清晰度和广告…";
        boolean probing;
        boolean probed;
        boolean recommended;
        Playlist.Report report;

        Line(String show, String sourceName, String remarks, String vodId, String sourceJson, String firstEpisode) {
            this.show = show;
            this.sourceName = sourceName.isEmpty() ? "片源" : sourceName;
            this.remarks = remarks;
            this.vodId = vodId;
            this.sourceJson = sourceJson;
            this.firstEpisode = firstEpisode == null ? "" : firstEpisode;
        }
    }

    private final class SourceAdapter extends RecyclerView.Adapter<SourceAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.item_source, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Line line = sources.get(position);
            holder.title.setText(line.recommended ? "推荐 · " + line.sourceName : line.sourceName);
            String subtitle = WorkKey.same(line.show, showTitle) ? "" : line.show;
            if (!line.remarks.isEmpty()) subtitle = subtitle.isEmpty() ? line.remarks : subtitle + "\n" + line.remarks;
            if (!line.label.isEmpty()) subtitle = subtitle.isEmpty() ? line.label : subtitle + "\n" + line.label;
            holder.subtitle.setText(subtitle);
            holder.itemView.setActivated(position == selected);
            holder.itemView.setOnFocusChangeListener((v, hasFocus) -> {
                FocusMotion.play(v, hasFocus);
                if (!hasFocus) return;
                if (line.label.isEmpty()) line.label = "正在分析清晰度和广告…";
                probe(line);
            });
            holder.itemView.setOnClickListener(v -> {
                int index = holder.getBindingAdapterPosition();
                if (index == RecyclerView.NO_POSITION) return;
                userPicked = true;
                select(index);
            });
        }

        @Override
        public int getItemCount() {
            return sources.size();
        }

        final class Holder extends RecyclerView.ViewHolder {
            final TextView title;
            final TextView subtitle;

            Holder(View view) {
                super(view);
                title = view.findViewById(R.id.title);
                subtitle = view.findViewById(R.id.subtitle);
            }
        }
    }

    private final class EpisodeAdapter extends RecyclerView.Adapter<EpisodeAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            TextView view = (TextView) getLayoutInflater().inflate(R.layout.item_episode, parent, false);
            return new Holder(view);
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            String label = episodeNumber(names.optString(position), position);
            Line line = selected >= 0 && selected < sources.size() ? sources.get(selected) : null;
            boolean resume = line != null && sameResume(line) && position == resumeEpisode;
            if (resume && resumePosition > 10) label = label + " · 续播";
            holder.label.setText(label);
            holder.label.setActivated(resume);
            FocusMotion.bind(holder.label);
            int index = position;
            holder.label.setOnClickListener(v -> play(index));
        }

        @Override
        public int getItemCount() {
            return episodes.length();
        }

        final class Holder extends RecyclerView.ViewHolder {
            final TextView label;

            Holder(View view) {
                super(view);
                label = (TextView) view;
            }
        }
    }
}
