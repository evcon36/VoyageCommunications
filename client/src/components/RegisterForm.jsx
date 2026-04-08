import { useState } from 'react';
import { registerUser } from '../services/auth';

export default function RegisterForm({ onSwitchToLogin }) {
  const [form, setForm] = useState({
    username: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
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
    setMessage('');
    setLoading(true);

    try {
      const result = await registerUser(form);
      setMessage(result.message || 'Аккаунт создан');
      setForm({ username: '', password: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-form-head">
        <h2>Регистрация</h2>
        <p>Создайте аккаунт в том же интерфейсе, где работает основной видеосервис.</p>
      </div>

      {message && <div className="auth-alert auth-alert-success">{message}</div>}
      {error && <div className="auth-alert auth-alert-error">{error}</div>}

      <div className="field-group">
        <label htmlFor="register-username">Имя пользователя</label>
        <input
          id="register-username"
          name="username"
          type="text"
          placeholder="Придумайте имя пользователя"
          value={form.username}
          onChange={handleChange}
          required
        />
      </div>

      <div className="field-group">
        <label htmlFor="register-password">Пароль</label>
        <input
          id="register-password"
          name="password"
          type="password"
          placeholder="Придумайте пароль"
          value={form.password}
          onChange={handleChange}
          required
        />
      </div>

      <div className="auth-actions">
        <button className="primary-btn" type="submit" disabled={loading}>
          {loading ? 'Создаём...' : 'Создать аккаунт'}
        </button>

        <button
          className="ghost-btn"
          type="button"
          onClick={onSwitchToLogin}
        >
          Войти
        </button>
      </div>
    </form>
  );
}