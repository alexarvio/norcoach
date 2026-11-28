package com.arvio.ironline;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Google (and, when it is on, Apple) sign-in for the Android app (28 Nov): the iPhone app's NorcoachAuth.openSignIn
 * (mobile/ios SceneDelegate.swift) on Android. Google refuses to sign in inside the app's web view, so the sign-in
 * opens in Chrome's Auth Tab where the browser has one (Chrome 137+), else in a Custom Tab, in cookies of its own
 * where the browser can (ephemeral, so a website session in Chrome is never picked up), and comes back on
 * norcoach://auth?code&state from /auth/native/finish. The site (app/login/ClerkFlows.tsx) does the rest: it checks
 * the state and trades the code and its secret for a Clerk ticket.
 *
 * Resolves {url} with the norcoach://auth address; rejects with the code "cancelled" when the person closes the tab.
 * Everything here runs on the main thread (Capacitor calls plugin methods on a thread of its own).
 */
// The ephemeral browsing calls are marked experimental in androidx.browser 1.9.0; in Java that is only lint's to say.
@SuppressLint("UnsafeOptInUsageError")
@CapacitorPlugin(name = "NorcoachAuth")
public class NorcoachAuthPlugin extends Plugin {

    private static final String SITE = "app.norcoachapp.com";
    private static final String SCHEME = "norcoach";
    private static final String HOST = "auth";

    private final Handler main = new Handler(Looper.getMainLooper());
    private ActivityResultLauncher<Intent> authTab;
    /** The openSignIn call waiting for the tab to come back. */
    private String pendingId;
    /** True while a plain Custom Tab is out (no Auth Tab): only then does coming back with nothing mean Cancel. */
    private boolean viaCustomTab;

    @Override
    public void load() {
        // Plugins load inside BridgeActivity.onCreate, before the activity starts, as registering for a result needs.
        authTab = AuthTabIntent.registerActivityResultLauncher(getActivity(), (AuthTabIntent.AuthResult result) -> {
            if (result.resultCode == AuthTabIntent.RESULT_OK && result.resultUri != null) {
                answer(result.resultUri, null, null);
            } else if (result.resultCode == AuthTabIntent.RESULT_CANCELED) {
                answer(null, "Cancelled", "cancelled");
            } else {
                answer(null, "Sign-in failed", null);
            }
        });
    }

    @PluginMethod
    public void openSignIn(PluginCall call) {
        String address = call.getString("url");
        Uri uri = address == null ? null : Uri.parse(address);
        if (uri == null || !"https".equals(uri.getScheme()) || !SITE.equals(uri.getHost())) {
            call.reject("Not a Norcoach address");
            return;
        }
        call.setKeepAlive(true);
        bridge.saveCall(call);
        main.post(() -> open(call, uri));
    }

    private void open(PluginCall call, Uri uri) {
        // A sign-in still out from before (its tab left open behind the app) is let go.
        answer(null, "Cancelled", "cancelled");
        pendingId = call.getCallbackId();

        Context context = getContext();
        String browser = CustomTabsClient.getPackageName(context, null);
        try {
            if (browser != null && authTab != null && CustomTabsClient.isAuthTabSupported(context, browser)) {
                viaCustomTab = false;
                AuthTabIntent tab = new AuthTabIntent.Builder().setEphemeralBrowsingEnabled(true).build();
                tab.intent.setPackage(browser);
                tab.launch(authTab, uri, SCHEME);
                return;
            }
            CustomTabsIntent.Builder builder = new CustomTabsIntent.Builder()
                .setShowTitle(true)
                .setShareState(CustomTabsIntent.SHARE_STATE_OFF);
            if (browser != null && CustomTabsClient.isEphemeralBrowsingSupported(context, browser)) {
                builder.setEphemeralBrowsingEnabled(true);
            }
            CustomTabsIntent tab = builder.build();
            if (browser != null) tab.intent.setPackage(browser);
            // No NO_HISTORY and no NEW_TASK: the tab stays in the app's task, so leaving it for a
            // 2-Step code and coming back finds it still there; norcoach://auth brings the singleTask
            // MainActivity forward and clears the tab above it.
            viaCustomTab = true;
            tab.launchUrl(getActivity(), uri);
        } catch (ActivityNotFoundException e) {
            answer(null, "Couldn't open the sign-in", null);
        }
    }

    /** The Custom Tab's way back: the browser opens norcoach://auth, which lands here (MainActivity is singleTask). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        if (data != null && SCHEME.equals(data.getScheme()) && HOST.equals(data.getHost())) {
            answer(data, null, null);
        }
    }

    /** Back in the app with no address (the Custom Tab closed with Back or its ✕): Cancelled, as on the iPhone. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pendingId == null || !viaCustomTab) return;
        final String waiting = pendingId;
        // onNewIntent comes before onResume, so a real way back has answered by now; a moment's grace all the same.
        main.postDelayed(
            () -> {
                if (waiting.equals(pendingId)) answer(null, "Cancelled", "cancelled");
            },
            400
        );
    }

    /** Answers the waiting call once: the address it came back on, or the words (and code) it failed with. */
    private void answer(Uri uri, String message, String code) {
        if (pendingId == null) return;
        PluginCall call = bridge.getSavedCall(pendingId);
        pendingId = null;
        viaCustomTab = false;
        if (call == null) return;
        if (uri != null) {
            JSObject ret = new JSObject();
            ret.put("url", uri.toString());
            call.resolve(ret);
        } else if (code != null) {
            call.reject(message, code);
        } else {
            call.reject(message);
        }
        bridge.releaseCall(call);
    }
}
