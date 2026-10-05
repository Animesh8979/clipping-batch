import os
import requests, base64

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

def read_b64(path):
  with open(path, "rb") as f:
    return base64.b64encode(f.read()).decode()

key = os.environ.get("NVIDIA_API_KEY", "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")

headers = {
  "Authorization": f"Bearer {key}",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "google/diffusiongemma-26b-a4b-it",
  "messages": [{"role":"user","content":"Analyze this video structure"}],
  "max_tokens": 4096,
  "temperature": 1.00,
  "top_p": 0.95,
  "stream": stream,
  "chat_template_kwargs": {"enable_thinking":True},
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
