package app.libretv.player;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
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
    private final List<Card> results = new ArrayList<>();
    private EditText query;
    private TextView message;
    private RecyclerView list;
    private int searchGeneration;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_search);
        query = findViewById(R.id.query);
        message = findViewById(R.id.message);
        list = findViewById(R.id.results);
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
        String preset = getIntent().getStringExtra(QUERY);
        if (preset != null && !preset.isEmpty()) {
            query.setText(preset);
            runSearch();
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
            if (results.size() == 1) list.requestFocus();
        }, failures -> {
            if (generation != searchGeneration) return;
            if (results.isEmpty()) message.setText("没有找到");
            else if (failures > 0) message.setText(results.size() + " 部 · " + failures + " 个源没有回应");
        }, e -> {
            if (generation == searchGeneration) message.setText(e.getMessage());
        });
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
