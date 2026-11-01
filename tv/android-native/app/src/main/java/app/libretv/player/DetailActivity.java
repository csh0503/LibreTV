package app.libretv.player;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

public class DetailActivity extends Activity {
    public static final String TITLE = "title";
    public static final String VOD_ID = "vod_id";
    public static final String SOURCE = "source";
    public static final String EPISODE = "episode";
    public static final String POSITION = "position";

    private TextView message;
    private JSONArray episodes = new JSONArray();
    private JSONArray names = new JSONArray();
    private int resumeEpisode;
    private int resumePosition;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_detail);
        message = findViewById(R.id.message);
        TextView title = findViewById(R.id.title);
        title.setText(getIntent().getStringExtra(TITLE));
        resumeEpisode = getIntent().getIntExtra(EPISODE, 0);
        resumePosition = getIntent().getIntExtra(POSITION, 0);
        RecyclerView list = findViewById(R.id.episodes);
        list.setLayoutManager(new GridLayoutManager(this, 8));
        list.setAdapter(new EpisodeAdapter());
        String vodId = getIntent().getStringExtra(VOD_ID);
        String rawSource = getIntent().getStringExtra(SOURCE);
        final String sourceJson = rawSource == null || rawSource.isEmpty() ? "{}" : rawSource;
        message.setText("正在获取剧集…");
        NativeApp.io(this, () -> NativeApp.api().detail(vodId, new JSONObject(sourceJson)), this::show, e -> message.setText(e.getMessage()));
    }

    private void show(JSONObject detail) {
        episodes = detail.optJSONArray("episodes");
        if (episodes == null) episodes = new JSONArray();
        names = detail.optJSONArray("episodeNames");
        if (names == null) names = new JSONArray();
        RecyclerView list = findViewById(R.id.episodes);
        if (list.getAdapter() != null) list.getAdapter().notifyDataSetChanged();
        if (episodes.length() == 0) {
            message.setText("未找到播放资源");
            return;
        }
        message.setText("共 " + episodes.length() + " 集");
        if (resumeEpisode >= 0 && resumeEpisode < episodes.length()) {
            list.scrollToPosition(resumeEpisode);
            int index = resumeEpisode;
            list.post(() -> {
                RecyclerView.ViewHolder holder = list.findViewHolderForAdapterPosition(index);
                if (holder != null) holder.itemView.requestFocus();
                else list.requestFocus();
            });
        } else {
            list.requestFocus();
        }
    }

    private void play(int index) {
        String url = episodes.optString(index);
        if (url.isEmpty()) {
            message.setText("这一集没有地址");
            return;
        }
        String label = names.optString(index);
        if (label.isEmpty()) label = "第 " + (index + 1) + " 集";
        String title = getIntent().getStringExtra(TITLE);
        int position = index == resumeEpisode ? resumePosition : 0;
        Open.play(this, title + " · " + label, url, position);
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
            String label = names.optString(position);
            if (label.isEmpty()) label = String.valueOf(position + 1);
            if (position == resumeEpisode && resumePosition > 10) label = label + " · 续播";
            holder.label.setText(label);
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
