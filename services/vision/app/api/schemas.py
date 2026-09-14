from pydantic import BaseModel


class OfferModel(BaseModel):
    sdp: str
    type: str
