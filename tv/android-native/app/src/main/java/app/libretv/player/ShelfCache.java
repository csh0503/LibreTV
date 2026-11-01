package app.libretv.player;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Last home shelves, so the next open can paint before the network answers. */
final class ShelfCache {
    private static final String FILE = "shelf-cache.json";
    private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;
    private static final int MAX_BYTES = 1_500_000;

    private ShelfCache() {}

    static JSONArray read(Context context) {
        File file = new File(context.getFilesDir(), FILE);
        if (!file.isFile() || file.length() == 0 || file.length() > MAX_BYTES) return null;
        try {
            byte[] bytes = new byte[(int) file.length()];
            int read;
            try (FileInputStream in = new FileInputStream(file)) {
                read = in.read(bytes);
            }
            if (read <= 0) return null;
            JSONObject root = new JSONObject(new String(bytes, 0, read, StandardCharsets.UTF_8));
            if (System.currentTimeMillis() - root.optLong("at") > MAX_AGE_MS) return null;
            JSONArray shelves = root.optJSONArray("shelves");
            return shelves == null || shelves.length() == 0 ? null : shelves;
        } catch (Exception e) {
            return null;
        }
    }

    static void write(Context context, String json) {
        if (json == null || json.isEmpty()) return;
        File file = new File(context.getFilesDir(), FILE);
        File tmp = new File(context.getFilesDir(), FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(file)) {
            file.delete();
            tmp.renameTo(file);
        }
    }
}
