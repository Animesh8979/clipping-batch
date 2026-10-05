import os
import requests, base64

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

api_key = os.environ.get("NVIDIA_API_KEY_4", "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")

headers = {
  "Authorization": f"Bearer {api_key}",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "qwen/qwen3.5-122b-a10b",
  "messages": [{"role":"user","content":"Hello Qwen!"}],
  "max_tokens": 16384,
  "temperature": 0.60,
  "top_p": 0.95,
  "stream": stream,
}

try:
    response = requests.post(invoke_url, headers=headers, json=payload, stream=stream)
    if stream:
        for line in response.iter_lines():
            if line:
                print(line.decode("utf-8"))
    else:
        print(response.json())
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
