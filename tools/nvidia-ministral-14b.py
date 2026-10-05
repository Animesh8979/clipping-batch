import os
import requests

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

api_key = os.environ.get("NVIDIA_API_KEY_4", "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")

headers = {
  "Authorization": f"Bearer {api_key}",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "mistralai/ministral-14b-instruct-2512",
  "messages": [{"role":"user","content":"Hello from Ministral 14B!"}],
  "max_tokens": 2048,
  "temperature": 0.15,
  "top_p": 1.00,
  "frequency_penalty": 0.00,
  "presence_penalty": 0.00,
  "stream": stream
}

try:
    response = requests.post(invoke_url, headers=headers, json=payload)
    if stream:
        for line in response.iter_lines():
            if line:
                print(line.decode("utf-8"))
    else:
        print(response.json())
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
