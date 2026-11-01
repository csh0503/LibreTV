package app.libretv.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String HOME = "https://libre-tv-dusky-delta.vercel.app/";
    private WebView web;
    private FrameLayout root;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private String navJs = "";
    private String earlyJs = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled(true);
        navJs = readAsset("tv-nav.js");
        earlyJs = readAsset("early.js");
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web);
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(0xFF000000);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Keep navigation inside LibreTV so a page cannot send the TV to another site.
                Uri url = request.getUrl();
                return !Uri.parse(HOME).getHost().equals(url.getHost());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                view.evaluateJavascript(earlyJs, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(navJs, null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("LibreTvWeb", m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                customView = view;
                customCallback = callback;
                root.addView(view);
                web.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(HOME);
        web.requestFocus();
    }

    private static String direction(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "ArrowRight";
            default: return null;
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customCallback != null) customCallback.onCustomViewHidden();
        web.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (customView != null) exitFullscreen();
                else if (web.canGoBack()) web.goBack();
                else finish();
            }
            return true;
        }
        String dir = direction(event.getKeyCode());
        if (dir != null && customView == null) {
            // WebView's built-in D-pad focus stalls on this firmware, so tv-nav.js moves focus.
            // Key up is swallowed too; a key the script declines is replayed to the page as a pair.
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                KeyEvent down = new KeyEvent(event);
                web.evaluateJavascript("window.__tvMove?window.__tvMove('" + dir + "'):false", result -> {
                    if (!"true".equals(result)) {
                        web.dispatchKeyEvent(down);
                        web.dispatchKeyEvent(KeyEvent.changeAction(down, KeyEvent.ACTION_UP));
                    }
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }
}
