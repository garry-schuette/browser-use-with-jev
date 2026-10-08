import json

import httpx
import pytest

from browser_use_with_jev import HostModel, JevClient, JevError


def response(choice="a", confidence=0.9):
    return {
        "model": "jev-1.13",
        "answers": {
            "next": {
                "type": "choice",
                "choice": choice,
                "confidence": confidence,
                "probabilities": {"a": 0.9, "HOST": 0.1},
            }
        },
    }


async def test_request_keeps_key_out_of_body_and_validates_response():
    def handler(request):
        assert request.headers["authorization"] == "Bearer fake-private-key"
        assert b"fake-private-key" not in request.content
        assert request.url == "https://api.typesafe.ai/v1/systemone"
        assert set(json.loads(request.content)["questions"]["next"]["criteria"]) == {"a", "HOST"}
        return httpx.Response(200, json=response())

    client = JevClient("fake-private-key", transport=httpx.MockTransport(handler))
    decision = await client.choose({"page": "public fixture"}, {"a": "Click", "HOST": "Host"})
    assert decision.choice == "a"
    assert decision.probabilities == {"a": 0.9, "HOST": 0.1}
    assert "fake-private-key" not in repr(client)


@pytest.mark.parametrize(
    "payload",
    [
        response(choice="injected-selector"),
        response(confidence=True),
        response(confidence=2),
        {"answers": {}},
        response(choice="HOST"),
    ],
)
async def test_invalid_decisions_rejected(payload):
    client = JevClient(
        "fake", transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    )
    with pytest.raises(JevError, match="Invalid"):
        await client.choose({}, {"a": "Click", "HOST": "Host"})


@pytest.mark.parametrize("status", [302, 401, 429, 500])
async def test_http_errors_are_sanitized_and_not_retried(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, text="private upstream payload", headers={"location": "https://evil.test"}
        )

    client = JevClient("fake", transport=httpx.MockTransport(handler))
    with pytest.raises(JevError, match=f"HTTP {status}") as error:
        await client.choose({}, {"a": "Click", "HOST": "Host"})
    assert "private upstream" not in str(error.value)
    assert len(calls) == 1


def test_raw_key_and_dotenv_files_supported_without_modification(tmp_path):
    path = tmp_path / "credentials"
    for value in ["raw-test-key\n", 'TYPESAFE_API_KEY="raw-test-key"\n']:
        path.write_text(value)
        assert JevClient.from_env(path).api_key == "raw-test-key"
        assert path.read_text() == value


async def test_host_callback_validates_structured_output():
    from pydantic import BaseModel, ValidationError

    class Result(BaseModel):
        count: int

    async def callback(messages, **kwargs):
        return {"count": "wrong"}

    with pytest.raises(ValidationError):
        await HostModel(callback).ainvoke([], output_format=Result)
