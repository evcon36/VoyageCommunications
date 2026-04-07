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
    <form onSubmit={handleSubmit} className="auth-form">
      <h2>Вход</h2>

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

      {error && <p className="auth-error">{error}</p>}

      <button type="submit" disabled={loading}>
        {loading ? 'Входим...' : 'Войти'}
      </button>

      <p>
        Нет аккаунта?{' '}
        <button type="button" onClick={onSwitchToRegister}>
          Зарегистрироваться
        </button>
      </p>
    </form>
  );
}