import { useState } from 'react';
import { loginUser, send2faCode, verify2fa } from '../services/auth';
import { getAltDomainUrl, ALT_DOMAIN_HINT } from '../altDomain';

const METHOD_LABEL = { email: 'на почту', telegram: 'в Telegram', totp: 'из приложения' };

export default function LoginForm({ onLoginSuccess, onSwitchToRegister }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // сетевые сбои (не 401) — повод предложить запасной домен: провайдер может резать текущий
  const [netError, setNetError] = useState(false);
  const altUrl = getAltDomainUrl();

  // шаг 2FA
  const [twofa, setTwofa] = useState(null); // { pending, methods }
  const [method, setMethod] = useState(null); // 'email' | 'telegram' | 'totp'
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [sending, setSending] = useState(false);
  const [remember, setRemember] = useState(true);

  function handleChange(event) {
    setForm((prev) => ({ ...prev, [event.target.name]: event.target.value }));
  }

  function finish(result) {
    localStorage.setItem('token', result.token);
    // «запомнили устройство» — сервер прислал новый device_token, сохраняем,
    // чтобы при следующем входе на этом браузере 2FA не спрашивалась
    if (result.device_token) localStorage.setItem('deviceToken', result.device_token);
    onLoginSuccess(result.user, result.token);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      // если это устройство уже когда-то «запомнили» — шлём токен, сервер сам решит,
      // пропускать ли повторный запрос 2FA-кода
      const device_token = localStorage.getItem('deviceToken') || undefined;
      setNetError(false);
      const result = await loginUser({ ...form, device_token });
      if (result.twofa_required) {
        const methods = result.methods || [];
        setTwofa({ pending: result.pending, methods });
        // по умолчанию: totp если есть (код из приложения, без отправки), иначе первый канал
        setMethod(methods.includes('totp') ? 'totp' : methods[0] || null);
        setCode('');
        setSentTo('');
      } else {
        finish(result);
      }
    } catch (err) {
      setError(err.message);
      // err.status есть только у ответов сервера; его отсутствие = запрос не дошёл
      if (!err.status) setNetError(true);
    } finally {
      setLoading(false);
    }
  }

  async function sendCode(channel) {
    setError('');
    setSending(true);
    try {
      const r = await send2faCode({ pending: twofa.pending, channel });
      setSentTo(r.to || (channel === 'telegram' ? 'Telegram' : 'почту'));
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await verify2fa({ pending: twofa.pending, method, code: code.trim(), remember });
      finish(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function resetTwofa() {
    setTwofa(null); setMethod(null); setCode(''); setSentTo(''); setError('');
  }

  // ── Шаг 2: ввод кода 2FA ──
  if (twofa) {
    const isChannel = method === 'email' || method === 'telegram';
    return (
      <form className="auth-form" onSubmit={handleVerify}>
        <div className="auth-form-head">
          <h2>Подтверждение входа</h2>
          <p>Аккаунт защищён двухфакторной аутентификацией.</p>
        </div>

        {error && <div className="auth-alert auth-alert-error">{error}</div>}

        {twofa.methods.length > 1 && (
          <div className="twofa-methods">
            {twofa.methods.map((m) => (
              <button type="button" key={m}
                className={`ghost-btn twofa-method-btn${method === m ? ' twofa-method-btn--active' : ''}`}
                onClick={() => { setMethod(m); setCode(''); setSentTo(''); setError(''); }}>
                {m === 'email' ? 'Почта' : m === 'telegram' ? 'Telegram' : 'Приложение'}
              </button>
            ))}
          </div>
        )}

        {isChannel && (
          <div className="twofa-send-row">
            <button type="button" className="ghost-btn" disabled={sending} onClick={() => sendCode(method)}>
              {sending ? 'Отправляем…' : sentTo ? 'Отправить снова' : `Отправить код ${METHOD_LABEL[method]}`}
            </button>
            {sentTo && <span className="twofa-sent">Код отправлен: {sentTo}</span>}
          </div>
        )}

        <div className="field-group">
          <label htmlFor="twofa-code">Код подтверждения {method === 'totp' ? METHOD_LABEL.totp : ''}</label>
          <input
            id="twofa-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-значный код"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            required
          />
        </div>

        <label className="remember-device-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Запомнить это устройство на 30 дней</span>
        </label>

        <div className="auth-actions">
          <button className="primary-btn" type="submit" disabled={loading || code.trim().length < 4}>
            {loading ? 'Проверяем…' : 'Подтвердить'}
          </button>
          <button className="ghost-btn" type="button" onClick={resetTwofa}>Назад</button>
        </div>
      </form>
    );
  }

  // ── Шаг 1: логин/пароль ──
  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-form-head">
        <h2>Вход</h2>
        <p>Звонки работают и без аккаунта. Аккаунт добавляет контакты, запись разговоров и историю.</p>
      </div>

      {error && <div className="auth-alert auth-alert-error">{error}</div>}

      {netError && altUrl && (
        <div className="alt-domain-box">
          <div className="alt-domain-text">{ALT_DOMAIN_HINT}</div>
          <a className="ghost-btn alt-domain-btn" href={altUrl}>Открыть запасной вход</a>
        </div>
      )}

      <div className="field-group">
        <label htmlFor="login-username">Имя пользователя</label>
        <input
          id="login-username"
          name="username"
          type="text"
          placeholder="Введите имя пользователя"
          value={form.username}
          onChange={handleChange}
          required
        />
      </div>

      <div className="field-group">
        <label htmlFor="login-password">Пароль</label>
        <input
          id="login-password"
          name="password"
          type="password"
          placeholder="Введите пароль"
          value={form.password}
          onChange={handleChange}
          required
        />
      </div>

      <div className="auth-actions">
        <button className="primary-btn" type="submit" disabled={loading}>
          {loading ? 'Входим...' : 'Войти'}
        </button>

        <button className="ghost-btn" type="button" onClick={onSwitchToRegister}>
          Зарегистрироваться
        </button>
      </div>
    </form>
  );
}
