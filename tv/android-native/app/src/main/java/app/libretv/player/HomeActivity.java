package app.libretv.player;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class HomeActivity extends Activity {
    private static final String[] SHELF_IDS = {
            "hot-movies", "cn-tv", "anime-airing",
            "guoman", "kr-jp-tv", "us-tv",
            "variety", "acclaimed", "g-crime",
            "g-scifi", "g-romance", "g-comedy",
            "g-action", "doc"
    };
    private final List<Row> rows = new ArrayList<>();
    private final Row[] shelfSlots = new Row[SHELF_IDS.length];
    private final boolean[] shelfDone = new boolean[SHELF_IDS.length];
    private final JSONArray[] shelfRaw = new JSONArray[SHELF_IDS.length];
    private final RecyclerView.RecycledViewPool cardPool = new RecyclerView.RecycledViewPool();
    private int loadedThrough;
    private boolean batchBusy;
    private static final int SHELF_CARDS = 16;
    private boolean historyPlaced;
    private boolean historyReady;
    private boolean allowHistoryRefresh;
    private boolean userMoved;
    private RecyclerView list;
    private TextView message;
    private android.view.View hero;
    private ImageView heroImage;
    private TextView heroTitle;
    private TextView heroSub;
    private View skeleton;
    private Card heroCard;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_home);
        message = findViewById(R.id.message);
        list = findViewById(R.id.rows);
        list.setLayoutManager(new LinearLayoutManager(this));
        list.setItemAnimator(null);
        list.setHasFixedSize(true);
        list.setItemViewCacheSize(4);
        cardPool.setMaxRecycledViews(0, 20);
        list.setAdapter(new RowAdapter());
        list.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override
            public void onScrolled(@NonNull RecyclerView recyclerView, int dx, int dy) {
                if (dy > 0) maybeLoadMore();
            }
        });
        Button search = findViewById(R.id.search);
        search.setOnClickListener(v -> startActivity(new Intent(this, SearchActivity.class)));
        Button browse = findViewById(R.id.browse);
        browse.setOnClickListener(v -> BrowseActivity.open(this, "movie"));
        Button profile = findViewById(R.id.profile);
        profile.setOnClickListener(v -> startActivity(new Intent(this, ProfileActivity.class)));
        hero = findViewById(R.id.hero);
        heroImage = findViewById(R.id.hero_image);
        heroTitle = findViewById(R.id.hero_title);
        heroSub = findViewById(R.id.hero_sub);
        skeleton = findViewById(R.id.skeleton);
        hero.setOnClickListener(v -> {
            if (heroCard != null) Open.card(this, heroCard);
        });
        message.setText("正在准备首页…");
        JSONArray cached = ShelfCache.read(this);
        if (cached != null) acceptShelves(0, SHELF_IDS.length, cached, false);
        requestNextBatch();
        String profileId = ProfileActivity.rememberedId(this);
        NativeApp.io(this, () -> {
            if (NativeApp.api().sources().length() == 0) NativeApp.api().status();
            return profileId.isEmpty() ? new JSONObject() : NativeApp.api().bundle(profileId);
        }, this::showBundle, e -> message.setText(friendly(e)));
    }

    private void showBundle(JSONObject bundle) {
        String name = bundle.optString("name", "LibreTV");
        ((Button) findViewById(R.id.profile)).setText(name);
        addHistory(historyCards(bundle.optJSONArray("history")));
        addFavorites(bundle.optJSONArray("favorites"));
        historyReady = true;
        allowHistoryRefresh = true;
        if (!historyPlaced) focusFirstPlayable();
        if (message.getText().toString().startsWith("正在准备")) message.setText("");
    }

    /**
     * 返回键先回到顶部，再按一次才退出。
     * 十四排货架滚到下面以后，想回第一排要按很多次上。
     */
    @Override
    public void onBackPressed() {
        RecyclerView.LayoutManager manager = list.getLayoutManager();
        if (manager instanceof LinearLayoutManager) {
            if (((LinearLayoutManager) manager).findFirstVisibleItemPosition() > 0) {
                list.smoothScrollToPosition(0);
                return;
            }
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 不要在这里重置 userMoved：从详情返回时它会放行 focusContinue()，
        // 把列表滚回顶部并抢走焦点（用户刚看完一集回来就找不到刚才那一排）。
        if (list.findFocus() == null) list.post(this::restoreFocus);
        if (!allowHistoryRefresh) return;
        String profileId = ProfileActivity.rememberedId(this);
        if (profileId.isEmpty()) return;
        NativeApp.io(this, () -> NativeApp.api().bundle(profileId), bundle -> replaceHistory(bundle.optJSONArray("history")), e -> {
        });
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (historyReady && event.getAction() == android.view.KeyEvent.ACTION_DOWN) {
            int code = event.getKeyCode();
            if (code == android.view.KeyEvent.KEYCODE_DPAD_UP || code == android.view.KeyEvent.KEYCODE_DPAD_DOWN
                    || code == android.view.KeyEvent.KEYCODE_DPAD_LEFT || code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT
                    || code == android.view.KeyEvent.KEYCODE_DPAD_CENTER) {
                userMoved = true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * 刷新「继续观看」时只更新第一行的内容，不再 remove + insert。
     * 移除再插入会让 RecyclerView 重新定位，滚动位置和焦点都会跳掉。
     */
    private void replaceHistory(JSONArray history) {
        List<Card> cards = historyCards(history);
        if (!historyPlaced || rows.isEmpty() || !"继续观看".equals(rows.get(0).title)) {
            if (!cards.isEmpty()) addHistory(cards);
            return;
        }
        Row first = rows.get(0);
        if (cards.isEmpty()) {
            rows.remove(0);
            historyPlaced = false;
            if (list.getAdapter() != null) list.getAdapter().notifyItemRemoved(0);
            return;
        }
        first.cards.clear();
        first.cards.addAll(cards);
        if (list.getAdapter() != null) list.getAdapter().notifyItemChanged(0);
    }

    private List<Card> historyCards(JSONArray history) {
        List<Card> cards = new ArrayList<>();
        if (history == null) return cards;
        List<JSONObject> items = WorkKey.collapse(HistorySync.merge(history));
        int limit = Math.min(items.size(), 18);
        for (int i = 0; i < limit; i++) {
            JSONObject item = items.get(i);
            int episode = item.optInt("episodeIndex");
            int position = item.optInt("playbackPosition");
            int duration = item.optInt("duration");
            String subtitle = "第 " + (episode + 1) + " 集";
            if (position > 10) subtitle += " · " + format(position);
            int progress = duration > 30 && position > 0 ? Math.min(100, position * 100 / duration) : 0;
            cards.add(new Card(
                    item.optString("title"),
                    item.optString("pic"),
                    subtitle,
                    item.optString("vodId"),
                    Open.sourceJson(item),
                    episode,
                    position,
                    progress
            ));
        }
        return cards;
    }

    private void addHistory(List<Card> cards) {
        if (cards.isEmpty()) return;
        rows.add(0, new Row("继续观看", cards));
        historyPlaced = true;
        if (list.getAdapter() != null) list.getAdapter().notifyItemInserted(0);
        focusContinue();
        layoutShelves();
    }

    /** Shelves often finish first and used to keep the focus. Keep putting it back on 继续观看 until the user moves. */
    private void focusContinue() {
        if (userMoved || !historyPlaced) return;
        list.scrollToPosition(0);
        list.post(() -> focusCard(0, 0));
    }

    private void focusCard(int rowIndex, int attempt) {
        if (userMoved) return;
        RecyclerView.ViewHolder row = list.findViewHolderForAdapterPosition(rowIndex);
        if (row == null) {
            if (attempt < 4) list.post(() -> focusCard(rowIndex, attempt + 1));
            return;
        }
        RecyclerView cards = row.itemView.findViewById(R.id.row_cards);
        if (cards == null) return;
        cards.scrollToPosition(0);
        cards.post(() -> {
            if (userMoved) return;
            RecyclerView.ViewHolder card = cards.findViewHolderForAdapterPosition(0);
            if (card != null) card.itemView.requestFocus();
            else if (attempt < 4) list.post(() -> focusCard(rowIndex, attempt + 1));
        });
    }

    /** 从详情返回时焦点常常丢了（按 DOWN 会跳到顶栏），这里恢复到当前第一排的第一张。 */
    private void restoreFocus() {
        if (list.findFocus() != null || rows.isEmpty()) return;
        int row = 0;
        RecyclerView.LayoutManager manager = list.getLayoutManager();
        if (manager instanceof LinearLayoutManager) {
            int first = ((LinearLayoutManager) manager).findFirstVisibleItemPosition();
            if (first != RecyclerView.NO_POSITION) row = first;
        }
        final int target = Math.min(row, rows.size() - 1);
        RecyclerView.ViewHolder holder = list.findViewHolderForAdapterPosition(target);
        if (holder == null) return;
        RecyclerView cards = holder.itemView.findViewById(R.id.row_cards);
        if (cards == null) return;
        cards.post(() -> {
            RecyclerView.ViewHolder card = cards.findViewHolderForAdapterPosition(0);
            if (card != null && list.findFocus() == null) card.itemView.requestFocus();
        });
    }

    private void focusFirstPlayable() {
        if (userMoved || list.findFocus() != null) return;
        list.post(() -> focusCard(0, 0));
    }

    private void addFavorites(JSONArray favorites) {
        if (favorites == null || favorites.length() == 0) return;
        List<JSONObject> items = new ArrayList<>();
        for (int i = 0; i < favorites.length(); i++) {
            JSONObject item = favorites.optJSONObject(i);
            if (item != null && !item.optString("title").isEmpty()) items.add(item);
        }
        items.sort((a, b) -> Long.compare(b.optLong("addedAt"), a.optLong("addedAt")));
        List<Card> cards = new ArrayList<>();
        int limit = Math.min(items.size(), 18);
        for (int i = 0; i < limit; i++) {
            JSONObject item = items.get(i);
            cards.add(new Card(
                    item.optString("title"),
                    item.optString("pic"),
                    item.optString("year"),
                    item.optString("vodId"),
                    Open.sourceJson(item),
                    0,
                    0
            ));
        }
        if (cards.isEmpty()) return;
        int index = historyPlaced ? 1 : 0;
        rows.add(index, new Row("我的片单", cards));
        list.getAdapter().notifyItemInserted(index);
        layoutShelves();
    }

    /** One batch at a time. The rest wait until the user scrolls near the bottom. */
    private void requestNextBatch() {
        if (batchBusy || loadedThrough >= SHELF_IDS.length) return;
        int from = loadedThrough;
        int to = Math.min(from + 3, SHELF_IDS.length);
        StringBuilder ids = new StringBuilder();
        for (int i = from; i < to; i++) {
            if (ids.length() > 0) ids.append(',');
            ids.append(SHELF_IDS[i]);
        }
        batchBusy = true;
        NativeApp.io(this, () -> {
            if (NativeApp.api().sources().length() == 0) NativeApp.api().status();
            return NativeApp.api().shelves(ids.toString());
        }, shelves -> {
            batchBusy = false;
            loadedThrough = to;
            acceptShelves(from, to, shelves, true);
            rememberShelves();
            if (loadedThrough < 6) requestNextBatch();
            else maybeLoadMore();
        }, e -> {
            batchBusy = false;
            loadedThrough = to;
            message.setText(friendly(e));
            acceptShelves(from, to, new JSONArray(), true);
            maybeLoadMore();
        });
    }

    private void maybeLoadMore() {
        if (batchBusy || loadedThrough >= SHELF_IDS.length || rows.isEmpty()) return;
        RecyclerView.LayoutManager manager = list.getLayoutManager();
        if (!(manager instanceof LinearLayoutManager)) return;
        int last = ((LinearLayoutManager) manager).findLastVisibleItemPosition();
        if (last == RecyclerView.NO_POSITION) {
            list.post(this::maybeLoadMore);
            return;
        }
        if (last >= rows.size() - 4) requestNextBatch();
    }

    private void rememberShelves() {
        JSONArray snapshot = new JSONArray();
        try {
            for (int i = 0; i < SHELF_IDS.length; i++) {
                JSONArray items = shelfRaw[i];
                if (items == null || items.length() == 0) continue;
                JSONArray kept = new JSONArray();
                for (int n = 0; n < items.length() && kept.length() < 24; n++) {
                    JSONObject item = items.optJSONObject(n);
                    if (item == null || item.optString("title").isEmpty()) continue;
                    JSONObject copy = new JSONObject();
                    copy.put("title", item.optString("title"));
                    copy.put("cover", item.optString("cover"));
                    copy.put("remarks", item.optString("remarks"));
                    copy.put("year", item.optString("year"));
                    copy.put("rating", item.optString("rating"));
                    kept.put(copy);
                }
                if (kept.length() == 0) continue;
                JSONObject shelf = new JSONObject();
                shelf.put("id", SHELF_IDS[i]);
                shelf.put("items", kept);
                snapshot.put(shelf);
            }
        } catch (JSONException e) {
            return;
        }
        if (snapshot.length() == 0) return;
        String json;
        try {
            JSONObject root = new JSONObject();
            root.put("at", System.currentTimeMillis());
            root.put("shelves", snapshot);
            json = root.toString();
        } catch (JSONException e) {
            return;
        }
        NativeApp.io(this, () -> {
            ShelfCache.write(this, json);
            return Boolean.TRUE;
        }, ok -> {
        }, err -> {
        });
    }

    private void acceptShelves(int from, int to, JSONArray shelves, boolean persistable) {
        for (int slot = from; slot < to; slot++) {
            JSONArray items = itemsOf(SHELF_IDS[slot], shelves);
            if (items != null) shelfRaw[slot] = items;
            shelfDone[slot] = true;
        }
        layoutShelves();
        if (!persistable) {
            if (historyReady && historyPlaced) focusContinue();
            else if (historyReady && list.findFocus() == null) focusFirstPlayable();
        }
        if (message.getText().toString().startsWith("正在准备") && rows.size() > 0) message.setText("");
    }

    /** One show occupies the earliest row only, same rule as the website shelves. */
    private void layoutShelves() {
        Set<String> seen = personalKeys();
        for (int slot = 0; slot < SHELF_IDS.length; slot++) {
            if (!shelfDone[slot]) continue;
            putSlot(slot, rowFromRaw(slot, seen));
        }
        updateChrome();
    }

    /** 首屏引导图 + 骨架屏的显隐。第一排货架里挑评分最高的一部（评分太低就退回第一部有封面的）。 */
    private void updateChrome() {
        if (skeleton != null && !rows.isEmpty()) skeleton.setVisibility(View.GONE);
        if (heroCard != null || hero == null) return;
        JSONArray items = shelfRaw[0];
        if (items == null) return;
        JSONObject best = null;
        JSONObject firstWithCover = null;
        double bestRating = -1;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            if (item.optString("title").isEmpty() || item.optString("cover").isEmpty()) continue;
            if (firstWithCover == null) firstWithCover = item;
            double rating = parseRating(item.optString("rating"));
            if (rating > bestRating) {
                bestRating = rating;
                best = item;
            }
        }
        JSONObject pick = bestRating >= 7.0 ? best : firstWithCover;
        if (pick == null) return;
        String title = pick.optString("title");
        String cover = pick.optString("cover");
        String sub = pick.optString("remarks");
        String rating = pick.optString("rating");
        if (!rating.isEmpty()) sub = "★ " + rating + (sub.isEmpty() ? "" : " · " + sub);
        heroCard = new Card(title, cover, sub, "", "", 0, 0);
        heroTitle.setText(title);
        heroSub.setText(sub);
        heroSub.setVisibility(sub.isEmpty() ? View.GONE : View.VISIBLE);
        Images.loadLarge(heroImage, cover);
        Images.load(findViewById(R.id.hero_poster), cover);
        hero.setVisibility(View.VISIBLE);
    }

    private static double parseRating(String value) {
        if (value == null || value.isEmpty()) return -1;
        try {
            return Double.parseDouble(value.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 电视上别把异常类名丢给用户看。 */
    static String friendly(Exception e) {
        if (e instanceof java.net.SocketTimeoutException) return "网络有点慢，稍后再试";
        if (e instanceof java.net.UnknownHostException) return "连不上服务器，检查一下网络";
        if (e instanceof java.net.ConnectException) return "连不上服务器，检查一下网络";
        String m = e == null ? "" : e.getMessage();
        if (m == null || m.isEmpty() || m.contains("Exception") || m.startsWith("Failed")) return "出了点问题，按返回再进来试试";
        return m;
    }

    private Set<String> personalKeys() {
        Set<String> seen = new HashSet<>();
        for (Row row : rows) {
            if (!"继续观看".equals(row.title) && !"我的片单".equals(row.title)) continue;
            for (Card card : row.cards) {
                String key = WorkKey.of(card.title);
                if (!key.isEmpty()) seen.add(key);
            }
        }
        return seen;
    }

    private static JSONArray itemsOf(String id, JSONArray shelves) {
        for (int i = 0; i < shelves.length(); i++) {
            JSONObject shelf = shelves.optJSONObject(i);
            if (shelf != null && id.equals(shelf.optString("id"))) return shelf.optJSONArray("items");
        }
        return null;
    }

    private Row rowFromRaw(int slot, Set<String> seen) {
        JSONArray items = shelfRaw[slot];
        if (items == null) return null;
        List<Card> cards = new ArrayList<>();
        for (int n = 0; n < items.length(); n++) {
            JSONObject item = items.optJSONObject(n);
            if (item == null || item.optString("title").isEmpty()) continue;
            String key = WorkKey.of(item.optString("title"));
            if (!key.isEmpty() && seen.contains(key)) continue;
            if (cards.size() >= SHELF_CARDS) break;
            if (!key.isEmpty()) seen.add(key);
            String subtitle = item.optString("remarks");
            if (subtitle.isEmpty()) subtitle = item.optString("year");
            String rating = item.optString("rating");
            if (!rating.isEmpty()) subtitle = subtitle.isEmpty() ? "★ " + rating : "★ " + rating + " · " + subtitle;
            cards.add(new Card(item.optString("title"), item.optString("cover"), subtitle, "", "", 0, 0));
        }
        if (cards.isEmpty()) return null;
        // 每排最后一张「查看全部」：电视上货架只有 16 部，没有这个入口就只能靠搜索。
        cards.add(Card.seeAll(browseChannelOf(SHELF_IDS[slot]), "查看全部"));
        return new Row(titleOf(SHELF_IDS[slot]), cards);
    }

    /** 货架 → 片库频道。片库只做 6 个频道，题材行归到剧集里。 */
    private static String browseChannelOf(String shelfId) {
        switch (shelfId) {
            case "hot-movies": return "movie";
            case "anime-airing": return "anime";
            case "guoman": return "anime";
            case "variety": return "show";
            case "doc": return "doc";
            case "acclaimed": return "top";
            default: return "tv";
        }
    }

    private void putSlot(int slot, Row fresh) {
        Row old = shelfSlots[slot];
        if (fresh == null) {
            shelfSlots[slot] = null;
            if (old == null) return;
            int index = rows.indexOf(old);
            if (index >= 0 && list.getAdapter() != null) {
                rows.remove(index);
                list.getAdapter().notifyItemRemoved(index);
            }
            return;
        }
        if (old != null && sameCards(old, fresh)) return;
        shelfSlots[slot] = fresh;
        if (old != null) {
            int index = rows.indexOf(old);
            if (index >= 0) {
                rows.set(index, fresh);
                if (list.getAdapter() != null) list.getAdapter().notifyItemChanged(index);
                return;
            }
        }
        int at = shelfInsertAt(slot);
        rows.add(at, fresh);
        if (list.getAdapter() != null) list.getAdapter().notifyItemInserted(at);
    }

    private static boolean sameCards(Row old, Row fresh) {
        if (old.cards.size() != fresh.cards.size()) return false;
        for (int i = 0; i < old.cards.size(); i++) {
            if (!old.cards.get(i).title.equals(fresh.cards.get(i).title)) return false;
        }
        return true;
    }

    private int shelfInsertAt(int slot) {
        for (int i = slot - 1; i >= 0; i--) {
            if (shelfSlots[i] == null) continue;
            int index = rows.indexOf(shelfSlots[i]);
            if (index >= 0) return index + 1;
        }
        int at = 0;
        if (at < rows.size() && "继续观看".equals(rows.get(at).title)) at += 1;
        if (at < rows.size() && "我的片单".equals(rows.get(at).title)) at += 1;
        return at;
    }

    private static String titleOf(String id) {
        switch (id) {
            case "hot-movies": return "热门电影";
            case "cn-tv": return "华语热剧";
            case "anime-airing": return "日漫新番";
            case "guoman": return "国漫热播";
            case "kr-jp-tv": return "日韩剧集";
            case "us-tv": return "欧美剧集";
            case "variety": return "综艺热播";
            case "acclaimed": return "口碑佳作";
            case "g-crime": return "悬疑 · 犯罪";
            case "g-scifi": return "科幻 · 奇幻";
            case "g-romance": return "爱情 · 治愈";
            case "g-comedy": return "轻松喜剧";
            case "g-action": return "动作 · 冒险";
            case "doc": return "纪录片精选";
            default: return id;
        }
    }

    private static String format(int seconds) {
        return String.format("%d:%02d", seconds / 60, seconds % 60);
    }

    private static final class Row {
        final String title;
        final List<Card> cards;

        Row(String title, List<Card> cards) {
            this.title = title;
            this.cards = cards;
        }
    }

    private final class RowAdapter extends RecyclerView.Adapter<RowAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.row_shelf, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Row row = rows.get(position);
            holder.title.setText(row.title);
            if (holder.cards.getLayoutManager() == null) {
                holder.cards.setLayoutManager(new LinearLayoutManager(HomeActivity.this, LinearLayoutManager.HORIZONTAL, false));
                holder.cards.setItemAnimator(null);
                holder.cards.setNestedScrollingEnabled(false);
                holder.cards.setRecycledViewPool(cardPool);
                holder.cards.setItemViewCacheSize(4);
            }
            if (holder.cards.getAdapter() instanceof CardAdapter) {
                CardAdapter adapter = (CardAdapter) holder.cards.getAdapter();
                if (adapter.cards != row.cards) {
                    adapter.cards = row.cards;
                    holder.cards.post(adapter::notifyDataSetChanged);
                }
            } else {
                holder.cards.setAdapter(new CardAdapter(row.cards));
            }
        }

        @Override
        public int getItemCount() {
            return rows.size();
        }

        final class Holder extends RecyclerView.ViewHolder {
            final TextView title;
            final RecyclerView cards;

            Holder(View view) {
                super(view);
                title = view.findViewById(R.id.row_title);
                cards = view.findViewById(R.id.row_cards);
            }
        }
    }

    private final class CardAdapter extends RecyclerView.Adapter<CardAdapter.Holder> {
        List<Card> cards;

        CardAdapter(List<Card> cards) {
            this.cards = cards;
        }

        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.item_card, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Card card = cards.get(position);
            holder.title.setText(card.title);
            holder.subtitle.setText(card.subtitle);
            if (card.progressPercent > 0) {
                holder.progress.setVisibility(View.VISIBLE);
                holder.progress.setProgress(card.progressPercent);
            } else {
                holder.progress.setVisibility(View.GONE);
            }
            FocusMotion.bind(holder.itemView);
            if (card.seeAll) {
                // 结尾的「查看全部」：用箭头代替封面，跟旁边海报一眼能分开
                holder.image.setImageResource(R.drawable.ic_chevron);
                holder.image.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
                holder.image.setBackgroundColor(0xFF1C1C1C);
                int pad = Math.round(40 * getResources().getDisplayMetrics().density);
                holder.image.setPadding(pad, pad, pad, pad);
                holder.title.setTextSize(18);
                holder.subtitle.setVisibility(View.VISIBLE);
                holder.itemView.setOnClickListener(v -> BrowseActivity.open(HomeActivity.this, card.channel));
            } else {
                holder.title.setTextSize(16);
                holder.image.setScaleType(ImageView.ScaleType.CENTER_CROP);
                holder.image.setPadding(0, 0, 0, 0);
                holder.subtitle.setVisibility(View.VISIBLE);
                Images.load(holder.image, card.image);
                holder.itemView.setOnClickListener(v -> Open.card(HomeActivity.this, card));
            }
        }

        @Override
        public int getItemCount() {
            return cards.size();
        }

        final class Holder extends RecyclerView.ViewHolder {
            final ImageView image;
            final TextView title;
            final TextView subtitle;
            final android.widget.ProgressBar progress;

            Holder(View view) {
                super(view);
                image = view.findViewById(R.id.cover);
                title = view.findViewById(R.id.title);
                subtitle = view.findViewById(R.id.subtitle);
                progress = view.findViewById(R.id.progress);
            }
        }
    }
}
