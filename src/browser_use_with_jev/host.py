"""Adapt an embedding agent's own async inference callback to Browser Use."""

from browser_use.llm.views import ChatInvokeCompletion


class HostModel:
    """The callback receives messages and the requested Pydantic output_format.

    No network client or extra API key is created. The embedding runtime is
    responsible for obtaining its own model response and returning a dict/model
    (or a string for unstructured calls). This does not access Codex implicitly.
    """

    provider = "host"
    _verified_api_keys = True

    def __init__(self, callback, model="host-agent"):
        self.callback = callback
        self.model = model

    @property
    def name(self):
        return self.model

    @property
    def model_name(self):
        return self.model

    async def ainvoke(self, messages, output_format=None, **kwargs):
        value = await self.callback(messages, output_format=output_format, **kwargs)
        if output_format is not None:
            value = output_format.model_validate(value)
        elif not isinstance(value, str):
            raise TypeError("Unstructured host response must be a string")
        return ChatInvokeCompletion(completion=value, usage=None)
