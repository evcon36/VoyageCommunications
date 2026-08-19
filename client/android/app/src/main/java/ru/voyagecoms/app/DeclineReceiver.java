package ru.voyagecoms.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Отклонение прямо из уведомления, без открытия приложения. Ответ открывает
 * окно, а отказ этого не требует: человек отмахнулся и вернулся к своим делам.
 */
public class DeclineReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        CallNotifier.dismiss(context);
        CallNotifier.deliver("decline");
    }
}
