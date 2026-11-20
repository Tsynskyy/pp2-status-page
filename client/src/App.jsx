import { useEffect, useState } from "react";

const STATUS = { up: "Работает", down: "Не работает", unknown: "Нет данных" };
const time = (value) => (value ? new Date(value).toLocaleString("ru-RU") : "-");

async function api(path, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  const token = localStorage.getItem("token");
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch("/api" + path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw new Error("Сервер недоступен");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (response.status === 401) throw new Error("Неверный токен оператора");
  if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Ошибка сервера ${response.status}`);
  return data;
}

function useLoad(path, version) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const load = () => api(path).then((data) => setState({ data }), (error) => setState((s) => ({ ...s, error, loading: false })));
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [path, version]);
  return state;
}

function Loaded({ state, children }) {
  if (state.error) return <p className="error">{state.error.message}</p>;
  if (!state.data) return <p className="muted">Загрузка...</p>;
  return children(state.data);
}

function useAction(done) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return { busy, error, run };
}

const Badge = ({ status }) => <span className={`badge ${status}`}>{STATUS[status]}</span>;

function Login({ token, setToken }) {
  const [value, setValue] = useState("");
  if (token) return <button className="secondary" onClick={() => setToken("")}>Выйти</button>;
  return (
    <form onSubmit={(e) => (e.preventDefault(), value.trim() && setToken(value.trim()))}>
      <input type="password" placeholder="Токен оператора" value={value} onChange={(e) => setValue(e.target.value)} />
      <button disabled={!value.trim()}>Войти</button>
    </form>
  );
}

function Status({ version, select }) {
  return (
    <Loaded state={useLoad("/status", version)}>
      {({ status, services, incidents }) => (
        <section>
          <div className={`banner ${status}`}>{{ up: "Все сервисы работают", down: "Есть сбой", unknown: "Данных пока нет" }[status]}</div>
          {services.map((s) => (
            <div key={s.id} className="row card">
              <button className="link" onClick={() => select(s)}>{s.name}</button>
              <Badge status={s.status} />
            </div>
          ))}
          {incidents.map((i) => (
            <p key={i.id} className="error">{i.title} с {time(i.opened_at)}</p>
          ))}
        </section>
      )}
    </Loaded>
  );
}

function History({ service, version }) {
  return (
    <section>
      <h2>История: {service.name}</h2>
      <Loaded state={useLoad(`/services/${service.id}/checks`, version)}>
        {({ uptime, checks }) => (
          <>
            <p>Доступность: {uptime === null ? "нет данных" : `${uptime}%`}</p>
            <table>
              <tbody>
                {checks.map((c, i) => (
                  <tr key={i}>
                    <td>{time(c.at)}</td>
                    <td className={c.ok ? "ok" : "bad"}>{c.ok ? "OK" : "Сбой"}</td>
                    <td>{c.code ?? c.error}</td>
                    <td>{c.ms === null ? "" : `${c.ms} мс`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Loaded>
    </section>
  );
}

function ServiceForm({ service, done }) {
  const [name, setName] = useState(service?.name ?? "");
  const [url, setUrl] = useState(service?.url ?? "");
  const [invalid, setInvalid] = useState("");
  const { busy, error, run } = useAction(done);
  const submit = (e) => {
    e.preventDefault();
    const problem = !name.trim() ? "Укажите название" : !/^https?:\/\/\S+$/.test(url) ? "URL должен начинаться с http:// или https://" : "";
    setInvalid(problem);
    if (!problem) run(() => (service ? api(`/services/${service.id}`, "PUT", { name, url }) : api("/services", "POST", { name, url })));
  };
  return (
    <form onSubmit={submit}>
      <input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button disabled={busy}>{busy ? "Сохраняем..." : service ? "Сохранить" : "Добавить"}</button>
      {(invalid || error) && <p className="error">{invalid || error}</p>}
    </form>
  );
}

function Services({ version, changed }) {
  const [editing, setEditing] = useState(null);
  const { error, run } = useAction(changed);
  const done = () => (setEditing(null), changed());
  return (
    <section>
      <h2>Сервисы</h2>
      <ServiceForm key={version} done={done} />
      {error && <p className="error">{error}</p>}
      <Loaded state={useLoad("/services", version)}>
        {(services) =>
          services.map((s) =>
            editing === s.id ? (
              <ServiceForm key={s.id} service={s} done={done} />
            ) : (
              <div key={s.id} className="row card">
                <span>{s.name} <span className="muted">{s.url}</span></span>
                <span>
                  <button className="secondary" onClick={() => setEditing(s.id)}>Изменить</button>
                  <button className="secondary" onClick={() => confirm(`Удалить ${s.name}?`) && run(() => api(`/services/${s.id}`, "DELETE"))}>Удалить</button>
                </span>
              </div>
            )
          )
        }
      </Loaded>
    </section>
  );
}

function IncidentForm({ services, done }) {
  const [serviceId, setServiceId] = useState("");
  const [title, setTitle] = useState("");
  const [invalid, setInvalid] = useState("");
  const { busy, error, run } = useAction(done);
  const submit = (e) => {
    e.preventDefault();
    const problem = !serviceId ? "Выберите сервис" : title.trim().length < 3 ? "Описание не короче 3 символов" : "";
    setInvalid(problem);
    if (!problem) run(() => api("/incidents", "POST", { service_id: +serviceId, title }));
  };
  return (
    <form onSubmit={submit}>
      <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
        <option value="">Сервис</option>
        {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <input placeholder="Что случилось" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button disabled={busy}>{busy ? "Открываем..." : "Открыть инцидент"}</button>
      {(invalid || error) && <p className="error">{invalid || error}</p>}
    </form>
  );
}

function Incidents({ version, changed, operator }) {
  const services = useLoad("/services", version);
  const { error, run } = useAction(changed);
  return (
    <section>
      <h2>Инциденты</h2>
      {operator && services.data && <IncidentForm key={version} services={services.data} done={changed} />}
      {error && <p className="error">{error}</p>}
      <Loaded state={useLoad("/incidents", version)}>
        {(incidents) =>
          incidents.map((i) => (
            <div key={i.id} className="row card">
              <span>
                {i.title} <span className="muted">{time(i.opened_at)} - {i.closed_at ? time(i.closed_at) : "открыт"}{i.auto && ", автоматически"}</span>
              </span>
              {operator && !i.closed_at && <button className="secondary" onClick={() => run(() => api(`/incidents/${i.id}/close`, "POST"))}>Закрыть</button>}
            </div>
          ))
        }
      </Loaded>
    </section>
  );
}

export default function App() {
  const [token, setTokenState] = useState(localStorage.getItem("token") || "");
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(null);
  const setToken = (value) => (value ? localStorage.setItem("token", value) : localStorage.removeItem("token"), setTokenState(value));
  const changed = () => setVersion((v) => v + 1);
  return (
    <main>
      <header className="row">
        <h1>Status Page</h1>
        <Login token={token} setToken={setToken} />
      </header>
      <Status version={version} select={setSelected} />
      {selected && <History service={selected} version={version} />}
      {token && <Services version={version} changed={changed} />}
      <Incidents version={version} changed={changed} operator={!!token} />
    </main>
  );
}
