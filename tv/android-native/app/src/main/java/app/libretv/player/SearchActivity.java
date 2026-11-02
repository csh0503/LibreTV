package app.libretv.player;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class SearchActivity extends Activity {
    public static final String QUERY = "query";
    private static final String PREFS = "libretv_search";
    private static final String RECENT_KEY = "recent";
    private static final int RECENT_MAX = 8;

    private final List<Card> results = new ArrayList<>();
    private EditText query;
    private TextView message;
    private RecyclerView list;
    private LinearLayout recent;
    private HorizontalScrollView recentScroll;
    private int searchGeneration;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_search);
        query = findViewById(R.id.query);
        message = findViewById(R.id.message);
        list = findViewById(R.id.results);
        recent = findViewById(R.id.recent);
        recentScroll = findViewById(R.id.recent_scroll);
        list.setLayoutManager(new LinearLayoutManager(this));
        list.setAdapter(new ResultAdapter());
        query.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEARCH || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN)) {
                runSearch();
                return true;
            }
            return false;
        });
        findViewById(R.id.go).setOnClickListener(v -> runSearch());
        renderRecent();
        String preset = getIntent().getStringExtra(QUERY);
        if (preset != null && !preset.isEmpty()) {
            query.setText(preset);
            runSearch();
        } else if (recent.getChildCount() > 0) {
            // 有最近搜索就直接把焦点放在上面：遥控器不用先打一串字
            recent.getChildAt(0).requestFocus();
        } else {
            query.requestFocus();
        }
    }

    private void runSearch() {
        String text = query.getText().toString().trim();
        if (text.isEmpty()) {
            message.setText("输入片名");
            return;
        }
        message.setText("正在搜索…");
        results.clear();
        list.getAdapter().notifyDataSetChanged();
        int generation = ++searchGeneration;
        NativeApp.streamSearch(this, text, item -> {
            if (generation != searchGeneration) return;
            String name = item.optString("name");
            if (name.isEmpty()) return;
            String key = WorkKey.of(name);
            for (Card existing : results) {
                if (WorkKey.of(existing.title).equals(key)) return;
            }
            String subtitle = item.optString("remarks");
            String year = item.optString("year");
            if (!year.isEmpty()) subtitle = subtitle.isEmpty() ? year : subtitle + " · " + year;
            results.add(new Card(name, item.optString("pic"), subtitle, item.optString("vodId"), Open.sourceJson(item), 0, 0));
            list.getAdapter().notifyItemInserted(results.size() - 1);
            message.setText("已找到 " + results.size() + " 部");
            if (results.size() == 1) {
                // 第一部回来就收键盘、把焦点交给结果，否则软键盘会一直挡着半屏
                hideKeyboard();
                list.requestFocus();
            }
        }, failures -> {
            if (generation != searchGeneration) return;
            remember(text);
            renderRecent();
            if (results.isEmpty()) message.setText("没有找到");
            else if (failures > 0) message.setText(results.size() + " 部 · " + failures + " 个源没有回应");
        }, e -> {
            if (generation == searchGeneration) message.setText(HomeActivity.friendly(e));
        });
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused == null) return;
        InputMethodManager ime = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (ime != null) ime.hideSoftInputFromWindow(focused.getWindowToken(), 0);
    }

    // —— 最近搜索：电视上打字成本最高，能少打一次是一次 ——

    private void renderRecent() {
        recent.removeAllViews();
        List<String> items = recentQueries();
        if (items.isEmpty()) {
            recentScroll.setVisibility(View.GONE);
            return;
        }
        recentScroll.setVisibility(View.VISIBLE);
        for (String text : items) {
            TextView chip = new TextView(this);
            chip.setText(text);
            chip.setTextSize(17);
            chip.setTextColor(0xFFFFFFFF);
            chip.setPadding(dp(22), dp(12), dp(22), dp(12));
            chip.setBackgroundResource(R.drawable.focus_bg);
            chip.setFocusable(true);
            chip.setClickable(true);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMarginEnd(dp(10));
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                query.setText(text);
                query.setSelection(text.length());
                runSearch();
            });
            recent.addView(chip);
        }
    }

    private List<String> recentQueries() {
        List<String> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString(RECENT_KEY, "[]"));
            for (int i = 0; i < array.length() && out.size() < RECENT_MAX; i++) {
                String text = array.optString(i);
                if (!text.isEmpty() && !out.contains(text)) out.add(text);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void remember(String text) {
        List<String> items = recentQueries();
        items.remove(text);
        items.add(0, text);
        while (items.size() > RECENT_MAX) items.remove(items.size() - 1);
        JSONArray array = new JSONArray();
        for (String item : items) array.put(item);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(RECENT_KEY, array.toString()).apply();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class ResultAdapter extends RecyclerView.Adapter<ResultAdapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(getLayoutInflater().inflate(R.layout.item_result, parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Card card = results.get(position);
            holder.title.setText(card.title);
            holder.subtitle.setText(card.subtitle);
            Images.load(holder.cover, card.image);
            FocusMotion.bind(holder.itemView);
            holder.itemView.setOnClickListener(v -> Open.card(SearchActivity.this, card));
        }

        @Override
        public int getItemCount() {
            return results.size();
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
