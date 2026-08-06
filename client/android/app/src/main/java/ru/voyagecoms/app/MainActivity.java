package ru.voyagecoms.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Прав на камеру и микрофон в манифесте недостаточно: начиная с Android 6
 * их нужно спрашивать у человека во время работы. Без этого getUserMedia в
 * WebView отказывает молча, и человек попадает в звонок без себя.
 */
public class MainActivity extends BridgeActivity {

    private static final int MEDIA_PERMISSIONS = 4711;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        askForMedia();
    }

    private void askForMedia() {
        String[] needed = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO };
        boolean missing = false;
        for (String p : needed) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                missing = true;
                break;
            }
        }
        // Спрашиваем один раз при запуске: просить прямо в момент звонка хуже,
        // человек уже нажал «войти» и ждёт разговора, а не системных окон.
        if (missing) {
            ActivityCompat.requestPermissions(this, needed, MEDIA_PERMISSIONS);
        }
    }
}
