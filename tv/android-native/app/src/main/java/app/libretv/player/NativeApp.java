package app.libretv.player;

import android.app.Application;
import android.app.Activity;
import android.content.Intent;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public class NativeApp extends Application {
    private static NativeApp instance;
    private Api api;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        api = new Api(this);
    }

    public static Api api() {
        return instance.api;
    }

    public static <T> void io(Activity activity, Task<T> task, Consumer<T> ok, Consumer<Exception> err) {
        instance.pool.execute(() -> {
            try {
                T value = task.run();
                activity.runOnUiThread(() -> {
                    if (!activity.isFinishing()) ok.accept(value);
                });
            } catch (Exception e) {
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing()) return;
                    if (e instanceof Api.AuthException) {
                        instance.api.cookies().clear();
                        Intent login = new Intent(activity, LoginActivity.class);
                        login.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                        activity.startActivity(login);
                        return;
                    }
                    err.accept(e);
                });
            }
        });
    }

    public static void streamSearch(Activity activity, String query, Consumer<JSONObject> onItem, Consumer<Integer> done, Consumer<Exception> err) {
        instance.pool.execute(() -> {
            try {
                int failures = instance.api.searchEach(query, item -> activity.runOnUiThread(() -> {
                    if (!activity.isFinishing()) onItem.accept(item);
                }));
                activity.runOnUiThread(() -> {
                    if (!activity.isFinishing()) done.accept(failures);
                });
            } catch (Exception e) {
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing()) return;
                    if (e instanceof Api.AuthException) {
                        instance.api.cookies().clear();
                        Intent login = new Intent(activity, LoginActivity.class);
                        login.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                        activity.startActivity(login);
                        return;
                    }
                    err.accept(e);
                });
            }
        });
    }

    public interface Task<T> {
        T run() throws Exception;
    }
}
