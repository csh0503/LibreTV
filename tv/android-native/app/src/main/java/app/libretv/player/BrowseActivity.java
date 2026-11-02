package app.libretv.player;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 分类片库：首页每排货架末尾的「查看全部」进这里。
 * 电视上「随便看看有什么」是主要的使用方式，光靠 14 排货架和搜索不够。
 */
public class BrowseActivity extends Activity {
    public static final String CHANNEL = "channel";

    private static final String[] IDS = {"movie", "tv", "anime", "show", "doc", "top"};
    private static final String[] LABELS = {"电影", "剧集", "动漫", "综艺", "纪录片", "高分"};

    private final List<Card> items = new ArrayList<>();
    private final LinearLayout[] tabs = new LinearLayout[IDS.length];
    private RecyclerView grid;
    private TextView message;
    private String channel = "movie";
    /** 豆瓣排序：U 近期热门 / R 高分 / S 最新 */
    private String sort = "U";
    /** 空 = 全部，airing = 连载中，ended = 已完结 */
    private String status = "";
    private LinearLayout filterRow;
    private int pageStart;
    private boolean loading;
    private boolean end;
    /** 一次取回多少条（跟 Api.browse 里的 pageSize 一致） */
    private static final int PAGE_SIZE = 30;
    /** 已出现过的条目，翻页去重 */
    private final java.util.HashSet<String> seen = new java.util.HashSet<>();

    public static void open(Activity from, String channel) {
        Intent intent = new Intent(from, BrowseActivity.class);
        if (channel != null && !channel.isEmpty()) intent.putExtra(CHANNEL, channel);
        from.startActivity(intent);
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_browse);
        message = findViewById(R.id.message);
        grid = findViewById(R.id.grid);
        grid.setLayoutManager(new GridLayoutManager(this, 5));
        grid.setAdapter(new PosterAdapter());
        grid.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override
            public void onScrolled(@NonNull RecyclerView view, int dx, int dy) {
                if (dy <= 0) return;
                RecyclerView.LayoutManager manager = grid.getLayoutManager();
                if (!(manager instanceof GridLayoutManager)) return;
                int last = ((GridLayoutManager) manager).findLastVisibleItemPosition();
                if (last >= items.size() - 6) loadMore();
            }
        });
        // 恢复上次看的频道和筛选：每天都看剧集的人不该每次都从「电影 · 热门」开始
        android.content.SharedPreferences prefs = getSharedPreferences("libretv_browse", MODE_PRIVATE);
        channel = prefs.getString("channel", channel);
        sort = prefs.getString("sort", sort);
        status = prefs.getString("status", status);
        if (indexOf(channel) < 0) channel = "movie";
        String preset = getIntent().getStringExtra(CHANNEL);
        if (preset != null && indexOf(preset) >= 0) channel = preset;
        buildTabs();
        buildFilters();
        loadMore();
    }

    /** 每次改频道 / 排序 / 状态都记下来，下次进片库直接接着看。 */
    private void rememberBrowse() {
        getSharedPreferences("libretv_browse", MODE_PRIVATE).edit()
                .putString("channel", channel)
                .putString("sort", sort)
                .putString("status", status)
                .apply();
    }

    private int indexOf(String id) {
        for (int i = 0; i < IDS.length; i++) if (IDS[i].equals(id)) return i;
        return -1;
    }

    private void buildTabs() {
        LinearLayout row = findViewById(R.id.channels);
        row.removeAllViews();
        for (int i = 0; i < IDS.length; i++) {
            LinearLayout chip = new LinearLayout(this);
            chip.setOrientation(LinearLayout.HORIZONTAL);
            chip.setBackgroundResource(R.drawable.focus_bg);
            chip.setFocusable(true);
            chip.setClickable(true);
            chip.setPadding(dp(20), dp(10), dp(20), dp(10));
            TextView label = new TextView(this);
            label.setText(LABELS[i]);
            label.setTextSize(17);
            label.setTextColor(0xFFFFFFFF);
            chip.addView(label);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMarginEnd(dp(10));
            chip.setLayoutParams(lp);
            // 明确把「下」指向网格：默认焦点搜索在网格还没布局好时会跑到隔壁频道
            chip.setNextFocusDownId(R.id.grid);
            chip.setActivated(IDS[i].equals(channel));
            final String id = IDS[i];
            chip.setOnClickListener(v -> {
                if (id.equals(channel)) return;
                channel = id;
                rememberBrowse();
                pageStart = 0;
                end = false;
                items.clear();
                grid.getAdapter().notifyDataSetChanged();
                grid.scrollToPosition(0);
                for (int n = 0; n < IDS.length; n++) tabs[n].setActivated(IDS[n].equals(channel));
                loadMore();
            });
            tabs[i] = chip;
            row.addView(chip);
        }
        if (tabs.length > 0) {
            int at = Math.max(0, indexOf(channel));
            tabs[at].requestFocus();
        }
    }

    /** 排序三档 + 状态三档，跟频道按钮同一套视觉（白框焦点、蓝框选中）。 */
    private void buildFilters() {
        filterRow = findViewById(R.id.filters);
        filterRow.removeAllViews();
        addChip("s:U", "热门", () -> { sort = "U"; reload(); });
        addChip("s:R", "高分", () -> { sort = "R"; reload(); });
        addChip("s:S", "最新", () -> { sort = "S"; reload(); });
        addChip("t:", "全部", () -> { status = ""; reload(); });
        addChip("t:airing", "连载中", () -> { status = "airing"; reload(); });
        addChip("t:ended", "已完结", () -> { status = "ended"; reload(); });
        refreshFilters();
    }

    private void addChip(String tag, String label, Runnable onClick) {
        LinearLayout chip = new LinearLayout(this);
        chip.setOrientation(LinearLayout.HORIZONTAL);
        chip.setBackgroundResource(R.drawable.focus_bg);
        chip.setFocusable(true);
        chip.setClickable(true);
        chip.setTag(tag);
        chip.setPadding(dp(16), dp(8), dp(16), dp(8));
        TextView text = new TextView(this);
        text.setText(label);
        text.setTextSize(15);
        text.setTextColor(0xFFFFFFFF);
        chip.addView(text);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(8));
        chip.setLayoutParams(lp);
        // 跟频道按钮一样：下键直接进网格，别让焦点搜尋跑回上面那排
        chip.setNextFocusDownId(R.id.grid);
        chip.setOnClickListener(v -> onClick.run());
        filterRow.addView(chip);
    }

    private void refreshFilters() {
        if (filterRow == null) return;
        for (int i = 0; i < filterRow.getChildCount(); i++) {
            View chip = filterRow.getChildAt(i);
            String tag = String.valueOf(chip.getTag());
            String value = tag.length() > 2 ? tag.substring(2) : "";
            chip.setActivated(tag.startsWith("s:") ? value.equals(sort) : value.equals(status));
        }
    }

    private void reload() {
        rememberBrowse();
        pageStart = 0;
        end = false;
        items.clear();
        seen.clear();
        if (grid.getAdapter() != null) grid.getAdapter().notifyDataSetChanged();
        grid.scrollToPosition(0);
        refreshFilters();
        loadMore();
    }

    private void loadMore() {
        if (loading || end) return;
        loading = true;
        if (items.isEmpty()) message.setText("正在加载…");
        else message.setText("正在载入更多…");
        final int start = pageStart;
        final String kind = kindOf(channel);
        final String tags = tagsOf(channel);
        NativeApp.io(this, () -> NativeApp.api().browse(kind, tags, start, sort, status), list -> {
            loading = false;
            // 固定步进一页 30 条：用「返回条数」推进会因为过滤掉的条目而重叠，翻页翻出重复卡片
            pageStart = start + PAGE_SIZE;
            // 服务端会滤掉一部分条目，返回条数少于 30 不代表到底，只有空页才算
            if (list.length() == 0) end = true;
            int added = 0;
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null) continue;
                String title = item.optString("title");
                if (title.isEmpty()) continue;
                String key = title + "|" + item.optString("year");
                if (!seen.add(key)) continue;
                String subtitle = item.optString("year");
                String rating = item.optString("rating");
                if (!rating.isEmpty()) subtitle = "★ " + rating + (subtitle.isEmpty() ? "" : " · " + subtitle);
                String remarks = item.optString("remarks");
                if (!remarks.isEmpty() && remarks.length() <= 12) {
                    subtitle = subtitle.isEmpty() ? remarks : subtitle + " · " + remarks;
                }
                // 豆瓣条目没有可播地址，点开走「按片名找源」那条路
                items.add(new Card(title, item.optString("cover"), subtitle, "", "", 0, 0));
                added++;
            }
            // 只通知新增区间：notifyDataSetChanged 会让 RecyclerView 重新布局，
            // 翻页时把用户当前所在的行和焦点都甩回顶部。
            if (added > 0) grid.getAdapter().notifyItemRangeInserted(items.size() - added, added);
            boolean firstPage = items.size() == added;
            if (items.isEmpty()) message.setText("这里暂时没有内容");
            else if (end) message.setText(items.size() + " 部 · 已经到底了");
            else message.setText(items.size() + " 部");
            // 只有第一页才抢焦点；后续翻页抢焦点会把正在往下翻的用户拽回顶部
            if (firstPage && !items.isEmpty() && grid.findFocus() == null) {
                grid.post(() -> {
                    RecyclerView.ViewHolder holder = grid.findViewHolderForAdapterPosition(0);
                    if (holder != null) focusInTouchMode(holder.itemView);
                });
            }
        }, e -> {
            loading = false;
            message.setText(HomeActivity.friendly(e));
        });
    }

    /** 点过屏幕以后窗口在 touch mode，普通 requestFocus() 会静默失败。 */
    private static void focusInTouchMode(View view) {
        if (!view.requestFocus()) view.requestFocusFromTouch();
    }

    private static String kindOf(String channel) {
        if ("movie".equals(channel) || "doc".equals(channel) || "top".equals(channel)) return "movie";
        return "tv";
    }

    private static String tagsOf(String channel) {
        switch (channel) {
            case "anime": return "动画";
            case "show": return "综艺";
            case "doc": return "纪录片";
            case "top": return "豆瓣高分";
            case "tv": return "热门";
            default: return "热门";
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class PosterAdapter extends RecyclerView.Adapter<PosterAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.item_poster, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Card card = items.get(position);
            holder.title.setText(card.title);
            holder.subtitle.setText(card.subtitle);
            holder.subtitle.setVisibility(card.subtitle.isEmpty() ? View.GONE : View.VISIBLE);
            Images.load(holder.cover, card.image);
            FocusMotion.bind(holder.itemView);
            holder.itemView.setOnClickListener(v -> Open.card(BrowseActivity.this, card));
        }

        @Override
        public int getItemCount() {
            return items.size();
        }

        final class Holder extends RecyclerView.ViewHolder {
            final android.widget.ImageView cover;
            final TextView title;
            final TextView subtitle;

            Holder(View view) {
                super(view);
                cover = view.findViewById(R.id.cover);
                title = view.findViewById(R.id.title);
                subtitle = view.findViewById(R.id.subtitle);
            }
        }
    }
}
