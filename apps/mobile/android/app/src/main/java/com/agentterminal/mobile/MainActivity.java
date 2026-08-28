package com.agentterminal.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.View;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmbeddedNodePlugin.class);
        registerPlugin(ConnectionNotificationPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setLongClickable(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView().setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
    }
}
