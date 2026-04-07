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
    <form onSubmit={handleSubmit} className="auth-form">
      <h2>Регистрация</h2>

      <input
        type="text"
        name="username"
        placeholder="Никнейм"
        value={form.username}
        onChange={handleChange}
        required
      />

      <input
        type="password"
        name="password"
        placeholder="Пароль"
        value={form.password}
        onChange={handleChange}
        required
      />

      {message && <p className="auth-success">{message}</p>}
      {error && <p className="auth-error">{error}</p>}

      <button type="submit" disabled={loading}>
        {loading ? 'Создаём...' : 'Создать аккаунт'}
      </button>

      <p>
        Уже есть аккаунт?{' '}
        <button type="button" onClick={onSwitchToLogin}>
          Войти
        </button>
      </p>
    </form>
  );
}