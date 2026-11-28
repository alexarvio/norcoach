package com.arvio.ironline;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's own plugins, before the bridge is made in super.onCreate: NorcoachAuth signs in with Google (and
        // Apple, when it is on) in a browser tab, as Google refuses the app's web view (28 Nov).
        registerPlugin(NorcoachAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
