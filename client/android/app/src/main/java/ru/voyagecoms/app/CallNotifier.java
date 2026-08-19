package ru.voyagecoms.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Входящий звонок средствами системы.
 *
 * Раньше звонок жил только внутри окна приложения: свёрнутое приложение о нём
 * никак не сообщало, и человек видел пропущенный уже постфактум. Для продукта
 * про звонки это главный сценарий, и он не работал.
 *
 * Уведомление помечено как звонок и открывается на весь экран: система
 * показывает его поверх заблокированного экрана так же, как обычную звонилку.
 * Кнопки ответа и отклонения возвращают решение в приложение, поэтому
 * разворачивать окно необязательно.
 */
@CapacitorPlugin(name = "CallNotifier")
public class CallNotifier extends Plugin {

    private static final String CHANNEL_ID = "coms_incoming_calls";
    private static final int NOTIFICATION_ID = 4711;

    public static final String ACTION_ACCEPT = "ru.voyagecoms.app.CALL_ACCEPT";
    public static final String ACTION_DECLINE = "ru.voyagecoms.app.CALL_DECLINE";

    private static CallNotifier instance;

    @Override
    public void load() {
        instance = this;
        createChannel();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Показывает входящий звонок поверх экрана блокировки");
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        // Рингтон системной звонилки: человек узнаёт звук и понимает, что это
        // звонок, а не сообщение
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        ch.setSound(ring, attrs);
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 700, 600, 700, 600});
        nm.createNotificationChannel(ch);
    }

    @PluginMethod
    public void show(PluginCall call) {
        String from = call.getString("from", "Кто-то");
        Context ctx = getContext();

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent full = PendingIntent.getActivity(ctx, 0, open, flags);

        PendingIntent accept = PendingIntent.getActivity(
                ctx, 1, new Intent(ctx, MainActivity.class)
                        .setAction(ACTION_ACCEPT)
                        .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP),
                flags);
        PendingIntent decline = PendingIntent.getBroadcast(
                ctx, 2, new Intent(ACTION_DECLINE).setPackage(ctx.getPackageName()), flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle("Входящий звонок")
                .setContentText(from + " звонит в COMS")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                // Пока звонок идёт, уведомление нельзя смахнуть: иначе человек
                // случайно убирает его и не понимает, куда делся звонок
                .setOngoing(true)
                .setAutoCancel(false)
                // Главное: открывает экран поверх блокировки, как звонилка
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .addAction(0, "Ответить", accept)
                .addAction(0, "Отклонить", decline);

        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
            call.resolve();
        } catch (SecurityException e) {
            // Человек не дал разрешение на уведомления: звонок всё равно виден
            // внутри приложения, поэтому это не ошибка, а ограничение
            call.reject("Нет разрешения на уведомления");
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        call.resolve();
    }

    /** Решение из уведомления возвращается в приложение. */
    public static void deliver(String action) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        instance.notifyListeners("callAction", data);
    }

    public static void dismiss(Context ctx) {
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID);
    }
}
