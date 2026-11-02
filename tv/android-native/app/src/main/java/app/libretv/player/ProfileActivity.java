package app.libretv.player;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

public class ProfileActivity extends Activity {
    private static final String PROFILE_ID = "profile_id";
    private TextView message;
    private TextView retry;
    private JSONArray profiles = new JSONArray();

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_profiles);
        message = findViewById(R.id.message);
        retry = findViewById(R.id.retry);
        retry.setOnClickListener(v -> load());
        RecyclerView list = findViewById(R.id.list);
        list.setLayoutManager(new LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false));
        list.setAdapter(new Adapter());
        Button logout = findViewById(R.id.logout);
        logout.setOnClickListener(v -> NativeApp.io(this, () -> {
            NativeApp.api().logout();
            return Boolean.TRUE;
        }, ok -> {
            Intent login = new Intent(this, LoginActivity.class);
            login.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            startActivity(login);
        }, e -> message.setText(HomeActivity.friendly(e))));
        load();
    }

    /** 拉云端名单。失败时给一句人话 + 一个「重试」，否则用户只能强杀重开。 */
    private void load() {
        retry.setVisibility(View.GONE);
        message.setText("正在读取设定档…");
        NativeApp.io(this, () -> NativeApp.api().profiles(), this::showProfiles, e -> {
            message.setText(HomeActivity.friendly(e));
            retry.setVisibility(View.VISIBLE);
            retry.post(() -> {
                if (!retry.requestFocus()) retry.requestFocusFromTouch();
            });
        });
    }

    private void showProfiles(JSONArray incoming) {
        profiles = incoming == null ? new JSONArray() : incoming;
        RecyclerView list = findViewById(R.id.list);
        if (list.getAdapter() != null) list.getAdapter().notifyDataSetChanged();
        if (profiles.length() == 0) {
            message.setText("云端还没有设定档。先在网站上建一个。");
            return;
        }
        message.setText("谁在看？");
        String remembered = rememberedId(this);
        int focusIndex = 0;
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject item = profiles.optJSONObject(i);
            if (item != null && remembered.equals(item.optString("id"))) focusIndex = i;
        }
        if (profiles.length() == 1) {
            JSONObject only = profiles.optJSONObject(0);
            if (only != null && only.optString("pinHash").isEmpty()) {
                choose(only);
                return;
            }
        }
        int index = focusIndex;
        list.scrollToPosition(index);
        list.post(() -> focusCard(list, index, 0));
    }

    /**
     * 把焦点放到指定的设定档卡片上。
     * 列表刚绑定时 findViewHolder 还是 null，直接 requestFocus 也会因为 touch mode 失败，
     * 所以这里重试几次，并补 requestFocusFromTouch。
     */
    private void focusCard(RecyclerView list, int index, int attempt) {
        if (attempt > 8) return;
        RecyclerView.ViewHolder holder = list.findViewHolderForAdapterPosition(index);
        if (holder != null) {
            if (holder.itemView.requestFocus() || holder.itemView.requestFocusFromTouch()) return;
        }
        list.postDelayed(() -> focusCard(list, index, attempt + 1), 60);
    }

    private void choose(JSONObject profile) {
        String id = profile.optString("id");
        String pinHash = profile.optString("pinHash");
        if (pinHash.isEmpty()) {
            enter(id);
            return;
        }
        EditText input = new EditText(this);
        input.setHint("设定档密码");
        input.setTextColor(0xFFFFFFFF);
        input.setHintTextColor(0x88FFFFFF);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        new AlertDialog.Builder(this)
                .setTitle(profile.optString("name"))
                .setView(input)
                .setPositiveButton("进入", (d, w) -> {
                    if (Api.pinMatches(id, pinHash, input.getText().toString())) enter(id);
                    else message.setText("密码不对");
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void enter(String id) {
        NativeApp.api().cookies().prefs().edit().putString(PROFILE_ID, id).apply();
        Intent home = new Intent(this, HomeActivity.class);
        home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(home);
    }

    public static String rememberedId(android.content.Context context) {
        return NativeApp.api().cookies().prefs().getString(PROFILE_ID, "");
    }

    private final class Adapter extends RecyclerView.Adapter<Adapter.Holder> {
        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            TextView view = (TextView) getLayoutInflater().inflate(R.layout.item_profile, parent, false);
            return new Holder(view);
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            JSONObject profile = profiles.optJSONObject(position);
            String name = profile == null ? "" : profile.optString("name", "未命名");
            boolean pin = profile != null && !profile.optString("pinHash").isEmpty();
            holder.label.setText(pin ? name + "\n有密码" : name);
            holder.label.setOnClickListener(v -> {
                if (profile != null) choose(profile);
            });
        }

        @Override
        public int getItemCount() {
            return profiles.length();
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
