package com.agentterminal.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "AgentTerminal";
    private WebViewListener rendererListener;
    private boolean rendererRecoveryScheduled;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmbeddedNodePlugin.class);
        registerPlugin(ConnectionNotificationPlugin.class);
        registerPlugin(SystemMetricsPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setLongClickable(true);
        // xterm's DOM renderer aligns glyphs to cells with
        //   letter-spacing = cellWidth - glyphAdvance
        // where cellWidth is measured on an OffscreenCanvas and glyphAdvance is
        // a DOM offsetWidth. Blink's minimum font size floors DOM text layout
        // but NOT canvas measureText, so at the 8px WebView default any smaller
        // terminal font makes that subtraction negative and the glyphs collide -
        // and stop shrinking, because the DOM side is pinned at 8px while the
        // cells keep narrowing. Drop the floors so both sides of the
        // subtraction agree all the way down to the app's own 4px clamp
        // (MIN_ZOOM_FONT_SIZE in packages/protocol/src/terminal-layout.ts).
        // setTextZoom(100) closes the same gap from the other side: the OS font
        // scale multiplies DOM text and is likewise invisible to the canvas.
        // It pins the whole WebView against the system font-size setting, which
        // is deliberate - the app's chrome is laid out in fixed px throughout
        // apps/mobile/src/styles.css, and a terminal whose cell metrics drift
        // under text scaling is unusable.
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setMinimumFontSize(1);
        settings.setMinimumLogicalFontSize(1);
        settings.setTextZoom(100);
        rendererListener = new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                if (rendererRecoveryScheduled) return true;
                rendererRecoveryScheduled = true;
                Log.e(TAG, "The WebView renderer exited; recreating the mobile client.");
                ConnectionNotificationService.markReconnecting(MainActivity.this);
                runOnUiThread(() -> {
                    if (isFinishing() || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed())) return;
                    ViewParent parent = webView.getParent();
                    if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(webView);
                    webView.destroy();
                    recreate();
                });
                return true;
            }
        };
        getBridge().addWebViewListener(rendererListener);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView().setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
    }

    @Override
    public void onDestroy() {
        if (getBridge() != null && rendererListener != null) {
            getBridge().removeWebViewListener(rendererListener);
            rendererListener = null;
        }
        super.onDestroy();
    }
}
