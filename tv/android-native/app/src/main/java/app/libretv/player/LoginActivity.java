package app.libretv.player;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

public class LoginActivity extends Activity {
    private EditText password;
    private TextView message;
    private Button enter;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_login);
        password = findViewById(R.id.password);
        message = findViewById(R.id.message);
        enter = findViewById(R.id.enter);
        enter.setOnClickListener(v -> submit());
        password.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                submit();
                return true;
            }
            return false;
        });
        message.setText("正在连接…");
        NativeApp.io(this, () -> NativeApp.api().status(), this::onStatus, this::showError);
    }

    private void onStatus(JSONObject status) {
        if (status.optBoolean("verified") || (!status.optBoolean("passwordRequired") && NativeApp.api().cookies().hasSession())) {
            openProfiles();
            return;
        }
        if (!status.optBoolean("passwordRequired")) {
            openProfiles();
            return;
        }
        message.setText("输入 LibreTV 的网站密码");
        password.setEnabled(true);
        enter.setEnabled(true);
        password.requestFocus();
    }

    private void submit() {
        String value = password.getText().toString();
        if (value.isEmpty()) {
            message.setText("请输入密码");
            return;
        }
        password.setEnabled(false);
        enter.setEnabled(false);
        message.setText("正在登录…");
        NativeApp.io(this, () -> {
            NativeApp.api().login(value);
            NativeApp.api().status();
            return Boolean.TRUE;
        }, ok -> openProfiles(), e -> {
            password.setText("");
            password.setEnabled(true);
            enter.setEnabled(true);
            password.requestFocus();
            showError(e);
        });
    }

    private void openProfiles() {
        Intent next = new Intent(this, ProfileActivity.class);
        next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(next);
    }

    private void showError(Exception e) {
        message.setText(e.getMessage() == null ? "连接失败" : e.getMessage());
    }
}
