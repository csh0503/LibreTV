package app.libretv.player;

import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.PlayerView;

import java.net.URLEncoder;

public class PlayerActivity extends AppCompatActivity {
    public static final String TITLE = "title";
    public static final String URL = "url";
    public static final String POSITION = "position";
    public static final String WATCH = "watch";
    public static final String UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.120 Mobile Safari/537.36";

    private ExoPlayer player;
    private TextView overlay;
    private TextView heading;
    private TextView nextCard;
    private String directUrl = "";
    private org.json.JSONObject watch;
    private boolean triedProxy;
    private boolean resumeOnStart;
    private boolean cancelNext;
    private boolean nextVisible;
    private final Runnable hideOverlay = () -> overlay.setVisibility(View.GONE);
    private final Runnable watchEnding = this::watchEnding;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_player);
        overlay = findViewById(R.id.overlay);
        heading = findViewById(R.id.title);
        nextCard = findViewById(R.id.next);
        heading.setText(getIntent().getStringExtra(TITLE));
        directUrl = getIntent().getStringExtra(URL);
        String watchJson = getIntent().getStringExtra(WATCH);
        if (watchJson != null) {
            try {
                watch = new org.json.JSONObject(watchJson);
            } catch (org.json.JSONException ignored) {
                watch = null;
            }
        }
        if (directUrl == null || directUrl.isEmpty()) {
            overlay.setText("没有播放地址");
            return;
        }
        OkHttpDataSource.Factory dataSource = new OkHttpDataSource.Factory(NativeApp.api().playbackHttp());
        dataSource.setUserAgent(UA);
        DefaultTrackSelector tracks = new DefaultTrackSelector(this);
        tracks.setParameters(tracks.buildUponParameters()
                .setMaxVideoSize(1920, 1080)
                .setExceedVideoConstraintsIfNecessary(true));
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(10_000, 30_000, 1_000, 2_000)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
        player = new ExoPlayer.Builder(this)
                .setTrackSelector(tracks)
                .setLoadControl(load)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSource))
                .build();
        PlayerView view = findViewById(R.id.player);
        view.setPlayer(player);
        // 默认静音：这台电视平时开着当背景/在工作，出声很打扰。按 ↑ 或音量键恢复。
        player.setVolume(0f);
        mutedBadge = findViewById(R.id.muted_badge);
        picker = findViewById(R.id.picker);
        pickerList = findViewById(R.id.picker_list);
        pickerList.setLayoutManager(new androidx.recyclerview.widget.GridLayoutManager(this, 6));
        pickerList.setItemAnimator(null);
        pickerList.setAdapter(new EpisodePickerAdapter());
        hud = findViewById(R.id.hud);
        hudPosition = findViewById(R.id.hud_position);
        hudDuration = findViewById(R.id.hud_duration);
        hudBar = findViewById(R.id.hud_bar);
        player.addListener(new Player.Listener() {
            private boolean hinted;

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY && !hinted) {
                    hinted = true;
                    String hint = muted ? "已静音 · 按 ↑ 恢复声音" : "菜单键选择清晰度 · 片尾自动下一集";
                    // 从上次的位置接着播时说清楚，免得用户以为漏看了
                    if (resumeFrom > 30) hint = hint + " · 从 " + clock(resumeFrom) + " 继续";
                    show(hint);
                }
                if (state == Player.STATE_ENDED) {
                    hideNext();
                    if (hasNext() && !cancelNext) playNext();
                    else show("播放结束");
                }
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                if (!triedProxy && directUrl.startsWith("http")) {
                    triedProxy = true;
                    show("直连失败，改用代理重试…");
                    long pos = player.getCurrentPosition();
                    int saved = getIntent().getIntExtra(POSITION, 0);
                    if (pos < 1500 && saved > 10) pos = saved * 1000L;
                    play(proxyUrl(directUrl), pos);
                    return;
                }
                show(error.getErrorCodeName());
            }
        });
        int position = getIntent().getIntExtra(POSITION, 0);
        resumeFrom = position;
        play(directUrl, position * 1000L);
        overlay.post(watchEnding);
    }

    private void watchEnding() {
        if (player == null || isFinishing()) return;
        long duration = player.getDuration();
        long position = player.getCurrentPosition();
        boolean ending = duration > 20_000 && position > 0 && duration - position <= 12_000
                && player.getPlaybackState() != Player.STATE_ENDED;
        if (ending && hasNext() && !cancelNext) showNext((int) Math.ceil((duration - position) / 1000.0));
        else if (nextVisible && player.getPlaybackState() != Player.STATE_ENDED) hideNext();
        overlay.postDelayed(watchEnding, 1000);
    }

    private boolean hasNext() {
        if (watch == null) return false;
        org.json.JSONArray episodes = watch.optJSONArray("episodes");
        int next = watch.optInt("episodeIndex") + 1;
        return episodes != null && next < episodes.length() && !episodes.optString(next).isEmpty();
    }

    private void showNext(int seconds) {
        String label = episodeLabel(watch.optInt("episodeIndex") + 1);
        nextCard.setText("即将播放 " + label + "  ·  " + Math.max(seconds, 1) + " 秒\n确定 立即播放 · 返回 留在这一集");
        if (!nextVisible) {
            nextCard.setAlpha(0f);
            nextCard.setVisibility(View.VISIBLE);
            nextCard.animate().alpha(1f).setDuration(180).start();
        }
        nextVisible = true;
    }

    private void hideNext() {
        if (!nextVisible) return;
        nextVisible = false;
        nextCard.animate().alpha(0f).setDuration(120).withEndAction(() -> {
            if (!nextVisible) nextCard.setVisibility(View.GONE);
        }).start();
    }

    /** 遥控器上的「上一首」/CH- 键：回到上一集，进度从 0 开始。 */
    private void playPrev() {
        org.json.JSONArray episodes = watch == null ? null : watch.optJSONArray("episodes");
        int prev = watch == null ? -1 : watch.optInt("episodeIndex") - 1;
        if (episodes == null || prev < 0) {
            show("已经是第一集");
            return;
        }
        String url = episodes.optString(prev);
        if (url.isEmpty()) {
            show("上一集没有地址");
            return;
        }
        saveWatch();
        try {
            watch.put("episodeIndex", prev);
            watch.put("playbackPosition", 0);
        } catch (org.json.JSONException ignored) {
            return;
        }
        String label = episodeLabel(prev);
        String showTitle = watch.optString("title");
        heading.setText(showTitle.isEmpty() ? label : showTitle + " · " + label);
        directUrl = url;
        triedProxy = false;
        cancelNext = false;
        hideNext();
        play(url, 0);
    }

    private void playNext() {
        playEpisode(watch.optInt("episodeIndex") + 1);
    }

    /** 切到指定集（选集面板和「下一集」共用）。 */
    private void playEpisode(int index) {
        org.json.JSONArray episodes = watch == null ? null : watch.optJSONArray("episodes");
        if (episodes == null || index < 0 || index >= episodes.length()) return;
        String url = episodes.optString(index);
        if (url.isEmpty()) {
            show("这一集没有地址");
            return;
        }
        saveWatch();
        try {
            watch.put("episodeIndex", index);
            watch.put("playbackPosition", 0);
        } catch (org.json.JSONException ignored) {
            return;
        }
        String label = episodeLabel(index);
        String showTitle = watch.optString("title");
        heading.setText(showTitle.isEmpty() ? label : showTitle + " · " + label);
        directUrl = url;
        triedProxy = false;
        cancelNext = false;
        hideNext();
        hidePicker();
        play(url, 0);
    }

    /** 长按确定打开选集面板：不用退出播放器就能换集。 */
    private void showPicker() {
        if (watch == null || picker == null) return;
        org.json.JSONArray episodes = watch.optJSONArray("episodes");
        if (episodes == null || episodes.length() == 0) {
            show("这一路没有分集");
            return;
        }
        pickerShowing = true;
        if (heading != null) heading.setVisibility(View.GONE);
        picker.setVisibility(View.VISIBLE);
        pickerList.getAdapter().notifyDataSetChanged();
        int current = watch.optInt("episodeIndex");
        pickerList.post(() -> {
            pickerList.scrollToPosition(current);
            pickerList.postDelayed(() -> {
                androidx.recyclerview.widget.RecyclerView.ViewHolder holder =
                        pickerList.findViewHolderForAdapterPosition(current);
                if (holder == null) return;
                if (!holder.itemView.requestFocus()) holder.itemView.requestFocusFromTouch();
            }, 80);
        });
    }

    private void hidePicker() {
        if (!pickerShowing || picker == null) return;
        pickerShowing = false;
        picker.setVisibility(View.GONE);
        if (heading != null) heading.setVisibility(View.VISIBLE);
        if (player != null) player.play();
    }

    private final class EpisodePickerAdapter extends androidx.recyclerview.widget.RecyclerView.Adapter<EpisodePickerAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull android.view.ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.item_episode, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            holder.label.setText(String.valueOf(position + 1));
            holder.itemView.setActivated(watch != null && position == watch.optInt("episodeIndex"));
            FocusMotion.bind(holder.itemView);
            int index = position;
            holder.itemView.setOnClickListener(v -> playEpisode(index));
        }

        @Override
        public int getItemCount() {
            org.json.JSONArray episodes = watch == null ? null : watch.optJSONArray("episodes");
            return episodes == null ? 0 : episodes.length();
        }

        final class Holder extends androidx.recyclerview.widget.RecyclerView.ViewHolder {
            final TextView label;

            Holder(View view) {
                super(view);
                label = view.findViewById(R.id.label);
                View fill = view.findViewById(R.id.ep_fill);
                if (fill != null) fill.setVisibility(View.GONE);
            }
        }
    }

    private String episodeLabel(int index) {
        org.json.JSONArray names = watch == null ? null : watch.optJSONArray("episodeNames");
        String name = names == null ? "" : names.optString(index);
        String plain = "第" + (index + 1) + "集";
        if (name.isEmpty() || name.matches("\\d+") || name.replace(" ", "").equals(plain)) return "第 " + (index + 1) + " 集";
        return name;
    }

    private void play(String url, long positionMs) {
        player.setMediaItem(MediaItem.fromUri(Uri.parse(url)), Math.max(0, positionMs));
        player.prepare();
        player.play();
    }

    private String proxyUrl(String url) {
        try {
            return Api.BASE + "/api/proxy?url=" + URLEncoder.encode(url, "UTF-8");
        } catch (Exception e) {
            return url;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // 选集面板开着的时候把按键交给列表自己处理，只留返回键用来关闭
        if (pickerShowing) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                hidePicker();
                return true;
            }
            return false;
        }
        if (player != null && event.getAction() == KeyEvent.ACTION_DOWN) {
            int repeat = event.getRepeatCount();
            showHud();
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    seekBy(-1, repeat);
                    return true;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    seekBy(1, repeat);
                    return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_VOLUME_UP:
                    // 静音状态下按上键＝先恢复声音，不静音时才是调大系统音量
                    if (muted) {
                        setMuted(false);
                    } else {
                        volume(AudioManager.ADJUST_RAISE);
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_DOWN:
                case KeyEvent.KEYCODE_VOLUME_DOWN:
                    volume(AudioManager.ADJUST_LOWER);
                    return true;
                case KeyEvent.KEYCODE_VOLUME_MUTE:
                    setMuted(!muted);
                    return true;
                case KeyEvent.KEYCODE_MENU:
                case KeyEvent.KEYCODE_INFO:
                    // 菜单键 = 选集（换集比挑清晰度常用得多）；清晰度挪到长按确定
                    if (repeat == 0) showPicker();
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                case KeyEvent.KEYCODE_HEADSETHOOK:
                    if (repeat >= 2) {
                        // 长按确定 = 选清晰度
                        chooseQuality();
                        return true;
                    }
                    if (repeat == 0) {
                        // 片尾「即将播放下一集」的卡片正显示时，确定键应该是「马上播」，
                        // 而不是暂停一集马上就要结束的视频。
                        if (nextVisible && hasNext()) {
                            cancelNext = false;
                            playNext();
                        } else {
                            toggle();
                        }
                    }
                    return true;
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
                case KeyEvent.KEYCODE_CHANNEL_UP:
                    if (repeat == 0) {
                        cancelNext = false;
                        playNext();
                    }
                    return true;
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
                case KeyEvent.KEYCODE_CHANNEL_DOWN:
                    if (repeat == 0) playPrev();
                    return true;
                case KeyEvent.KEYCODE_BACK:
                    if (repeat == 0 && nextVisible && player.getPlaybackState() != Player.STATE_ENDED) {
                        cancelNext = true;
                        hideNext();
                        show("停在这一集");
                        return true;
                    }
                    break;
                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private long lastSeekAt;
    private int lastSeekDir;
    private int seekBurst = 1;
    /** 每次进播放页都从静音开始 */
    private boolean muted = true;
    private TextView mutedBadge;
    private View picker;
    private androidx.recyclerview.widget.RecyclerView pickerList;
    private boolean pickerShowing;
    /** 进页面时要续播的秒数，用来说明「从哪继续」 */
    private int resumeFrom;
    private View hud;
    private TextView hudPosition;
    private TextView hudDuration;
    private android.widget.ProgressBar hudBar;
    private final android.os.Handler hudHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable hudTick = new Runnable() {
        @Override
        public void run() {
            updateHud();
            if (hud.getVisibility() == View.VISIBLE) hudHandler.postDelayed(this, 500);
        }
    };
    private final Runnable hudHide = new Runnable() {
        @Override
        public void run() {
            hud.setVisibility(View.GONE);
            hudHandler.removeCallbacks(hudTick);
        }
    };

    /**
     * 快退/快进：按住不放（硬體連發）或快速連按，兩種都逐級加速 10 → 60 秒。
     * 很多電視遙控器只送單次按鍵、不送 repeat，所以不能只靠 repeatCount。
     */
    /** 任何按键都先把进度条亮出来，2.6 秒后自动收。 */
    private void showHud() {
        if (hud == null) return;
        hud.setVisibility(View.VISIBLE);
        hudHandler.removeCallbacks(hudHide);
        hudHandler.removeCallbacks(hudTick);
        updateHud();
        hudHandler.postDelayed(hudTick, 500);
        hudHandler.postDelayed(hudHide, 2600);
    }

    private void updateHud() {
        if (player == null || hudPosition == null) return;
        long duration = player.getDuration();
        long position = player.getCurrentPosition();
        // 暂停时在时间前面挂个 ❚❚：提示条 2.6 秒就淡掉了，之后靠这个看状态
        boolean playing = player.isPlaying() || player.getPlaybackState() != Player.STATE_READY;
        hudPosition.setText((playing ? "" : "❚❚ ") + clock(Math.max(0, position) / 1000));
        // 右边显示「还剩多久」比总时长有用；时长未知时退回总时长
        if (duration > 0 && duration - position > 1000) {
            hudDuration.setText("-" + clock((duration - position) / 1000));
        } else {
            hudDuration.setText(duration > 0 ? clock(duration / 1000) : "--:--");
        }
        hudBar.setProgress(duration > 0 ? (int) Math.min(1000, Math.max(0, position * 1000 / duration)) : 0);
        long buffered = player.getBufferedPosition();
        hudBar.setSecondaryProgress(duration > 0 ? (int) Math.min(1000, Math.max(0, buffered * 1000 / duration)) : 0);
    }

    private void seekBy(int direction, int repeat) {
        long now = System.currentTimeMillis();
        if (repeat > 0) {
            // 硬體連發：每 3 個 repeat 升一級
            seekBurst = Math.min(7, 1 + repeat / 3);
        } else if (direction == lastSeekDir && now - lastSeekAt < 700) {
            // 700ms：遥控器慢一点也不会把连按断开（550ms 时稍微慢按就回到 10 秒）
            seekBurst = Math.min(7, seekBurst + 1);
        } else {
            seekBurst = 1;
        }
        lastSeekAt = now;
        lastSeekDir = direction;
        // 第 7 级 = 2 分钟，长片按十几次就能到头
        long step = seekBurst >= 7 ? 120_000L : 10_000L * seekBurst;
        seek(direction * step);
    }

    private void chooseQuality() {
        if (player == null) return;
        java.util.ArrayList<String> labels = new java.util.ArrayList<>();
        java.util.ArrayList<Integer> heights = new java.util.ArrayList<>();
        java.util.ArrayList<androidx.media3.common.TrackSelectionOverride> overrides = new java.util.ArrayList<>();
        int selected = 0;
        for (androidx.media3.common.Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != androidx.media3.common.C.TRACK_TYPE_VIDEO) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                androidx.media3.common.Format format = group.getTrackFormat(i);
                String label = Playlist.Report.qualityName(format.height);
                if (label.isEmpty()) label = format.height > 0 ? format.height + "P" : "清晰度 " + (labels.size() + 1);
                if (group.isTrackSelected(i)) selected = labels.size();
                labels.add(label);
                heights.add(format.height);
                overrides.add(new androidx.media3.common.TrackSelectionOverride(group.getMediaTrackGroup(), java.util.Collections.singletonList(i)));
            }
        }
        if (labels.size() <= 1) {
            show(labels.isEmpty() ? "这一路没有多档清晰度" : "这一路只有 " + labels.get(0) + " · 插入广告会自动去掉");
            return;
        }
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("清晰度")
                .setSingleChoiceItems(labels.toArray(new String[0]), selected, (dialog, which) -> {
                    int height = heights.get(which);
                    androidx.media3.common.TrackSelectionParameters.Builder choice = player.getTrackSelectionParameters()
                            .buildUpon()
                            .setOverrideForType(overrides.get(which));
                    if (height > 1080) choice.setMaxVideoSize(Integer.MAX_VALUE, Integer.MAX_VALUE);
                    else choice.setMaxVideoSize(1920, 1080);
                    player.setTrackSelectionParameters(choice.build());
                    show(labels.get(which));
                    dialog.dismiss();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void seek(long deltaMs) {
        long next = Math.max(0, player.getCurrentPosition() + deltaMs);
        long duration = player.getDuration();
        if (duration > 0) next = Math.min(next, Math.max(0, duration - 500));
        player.seekTo(next);
        show(clock(next / 1000) + (deltaMs > 0 ? "  快进" : "  快退"));
    }

    private void volume(int direction) {
        AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI);
    }

    /** 播放器层面的静音：系统音量调多大都没用，这里才是真正的开关。 */
    private void setMuted(boolean value) {
        muted = value;
        if (player != null) player.setVolume(value ? 0f : 1f);
        if (mutedBadge != null) mutedBadge.setVisibility(value ? View.VISIBLE : View.GONE);
        show(value ? "已静音 · 按 ↑ 恢复声音" : "已恢复声音");
    }

    private void toggle() {
        if (player.isPlaying()) {
            player.pause();
            show("暂停");
        } else {
            player.play();
            show("播放");
        }
    }

    private void show(String text) {
        overlay.setText(text);
        overlay.setVisibility(View.VISIBLE);
        overlay.removeCallbacks(hideOverlay);
        overlay.postDelayed(hideOverlay, 1600);
    }

    private static String clock(long seconds) {
        return String.format("%d:%02d", seconds / 60, seconds % 60);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (player != null && resumeOnStart) {
            player.play();
            resumeOnStart = false;
        }
    }

    @Override
    protected void onStop() {
        saveWatch();
        if (player != null && player.isPlaying()) {
            player.pause();
            resumeOnStart = true;
        }
        super.onStop();
    }

    private void saveWatch() {
        if (player == null || watch == null) return;
        int position = (int) (player.getCurrentPosition() / 1000L);
        if (position <= 10 || watch.optString("vodId").isEmpty() || watch.optString("sourceKey").isEmpty()) return;
        try {
            org.json.JSONObject row = new org.json.JSONObject(watch.toString());
            row.put("playbackPosition", position);
            long durationMs = player.getDuration();
            if (durationMs > 0) row.put("duration", (int) (durationMs / 1000L));
            row.put("timestamp", System.currentTimeMillis());
            HistorySync.remember(this, row);
            String profileId = ProfileActivity.rememberedId(this);
            android.util.Log.i("LibreTv", "history local " + row.optString("title") + " " + position);
            NativeApp.io(this, () -> {
                HistorySync.push(profileId);
                return Boolean.TRUE;
            }, ok -> android.util.Log.i("LibreTv", "history cloud ok"), err -> android.util.Log.w("LibreTv", "history cloud " + err.getMessage()));
        } catch (org.json.JSONException ignored) {
            // 进度没写上时，下次打开仍用云端原来的位置。
        }
    }

    @Override
    protected void onDestroy() {
        overlay.removeCallbacks(watchEnding);
        hudHandler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
