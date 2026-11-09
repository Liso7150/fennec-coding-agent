# Colibri Coding Agent

Chat-first coding workspace: a FastAPI agent server (powered by
[`colibri-core`](https://github.com/Liso7150/colibri-core)) plus a Streamlit UI.

## Run

```bash
# agent server (real engine-backed loop)
python -m agent.server          # 127.0.0.1:8137

# workspace UI (Streamlit)
python -m streamlit run ui/app.py --server.port 8140
```

> The `ui/` Streamlit app currently renders from mock data (a design prototype);
> wiring it to the live `agent.server` is the next step. The real agent loop,
> tools and engine client live in `colibri-core`.

## Credits

Engine: [JustVugg/colibri](https://github.com/JustVugg/colibri). Fine-tuning:
[AirLLM](https://github.com/lyogavin/airllm). Part of the
[Colibri suite](https://github.com/Liso7150/colibri-environment-setup).