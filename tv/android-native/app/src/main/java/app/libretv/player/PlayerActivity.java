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
                    show(muted ? "已静音 · 按 ↑ 恢复声音" : "菜单键选择清晰度 · 片尾自动下一集");
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
        nextCard.setText("即将播放 " + label + "  ·  " + Math.max(seconds, 1) + " 秒\n返回留在这一集");
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
        org.json.JSONArray episodes = watch.optJSONArray("episodes");
        int next = watch.optInt("episodeIndex") + 1;
        if (episodes == null || next >= episodes.length()) return;
        String url = episodes.optString(next);
        if (url.isEmpty()) return;
        saveWatch();
        try {
            watch.put("episodeIndex", next);
            watch.put("playbackPosition", 0);
        } catch (org.json.JSONException ignored) {
            return;
        }
        String label = episodeLabel(next);
        String showTitle = watch.optString("title");
        heading.setText(showTitle.isEmpty() ? label : showTitle + " · " + label);
        directUrl = url;
        triedProxy = false;
        cancelNext = false;
        hideNext();
        play(url, 0);
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
                    if (repeat == 0) chooseQuality();
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                case KeyEvent.KEYCODE_HEADSETHOOK:
                    if (repeat == 0) toggle();
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
        hudPosition.setText(clock(Math.max(0, position) / 1000));
        hudDuration.setText(duration > 0 ? clock(duration / 1000) : "--:--");
        hudBar.setProgress(duration > 0 ? (int) Math.min(1000, Math.max(0, position * 1000 / duration)) : 0);
    }

    private void seekBy(int direction, int repeat) {
        long now = System.currentTimeMillis();
        if (repeat > 0) {
            // 硬體連發：每 3 個 repeat 升一級
            seekBurst = Math.min(6, 1 + repeat / 3);
        } else if (direction == lastSeekDir && now - lastSeekAt < 550) {
            seekBurst = Math.min(6, seekBurst + 1);
        } else {
            seekBurst = 1;
        }
        lastSeekAt = now;
        lastSeekDir = direction;
        seek(direction * 10_000L * seekBurst);
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
