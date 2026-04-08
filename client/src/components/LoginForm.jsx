import { useState } from 'react';
import { loginUser } from '../services/auth';

export default function LoginForm({ onLoginSuccess, onSwitchToRegister }) {
  const [form, setForm] = useState({
    username: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function handleChange(event) {
    setForm((prev) => ({
      ...prev,
      [event.target.name]: event.target.value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await loginUser(form);
      localStorage.setItem('token', result.token);
      onLoginSuccess(result.user, result.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-form-head">
        <h2>Вход</h2>
        <p>Войдите в аккаунт, чтобы открыть доступ к видеозвонкам.</p>
      </div>

      {error && <div className="auth-alert auth-alert-error">{error}</div>}

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

        <button
          className="ghost-btn"
          type="button"
          onClick={onSwitchToRegister}
        >
          Зарегистрироваться
        </button>
      </div>
    </form>
  );
}