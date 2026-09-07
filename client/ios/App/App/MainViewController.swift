import UIKit
import Capacitor

// Плагин звонков регистрируется здесь явно, а не через автоматическое
// обнаружение классов. Проверка на живом устройстве показала: мост его
// не видел, JS получал пустоту, и токен для входящих звонков не уходил
// на сервер вообще никогда. Явная регистрация не зависит от того, как
// именно Capacitor сканирует классы приложения.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoipPlugin())
    }
}
