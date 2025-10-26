// LOCATIONBLOCK.TSX

import "../css/LocationBlock.css";
import React from "react";

type Props = {
  name: string;
  description: string;
  estimatedCost?: string;
  imageUrl?: string;
};

const fallbackImg =
  "https://maps.gstatic.com/tactile/pane/default_geocode-2x.png"; // neutral placeholder

const LocationBlock: React.FC<Props> = ({
  name,
  description,
  estimatedCost,
  imageUrl,
}) => {
  const handleImgError: React.ReactEventHandler<HTMLImageElement> = (e) => {
    const img = e.currentTarget;
    if (img.src !== fallbackImg) {
      // prevent recursion if fallback also fails
      img.onerror = null;
      img.src = fallbackImg;
    }
  };

  return (
    <div className="location-block">
      <img
        src={imageUrl || fallbackImg}
        alt={name}
        loading="lazy"
        decoding="async"
        onError={handleImgError}
      />
      <div className="details">
        <h3 title={name}>{name}</h3>
        <p>{description}</p>
        {estimatedCost && <p className="sub">{estimatedCost}</p>}
      </div>

      <div className="drag-indicator"></div>
    </div>
  );
};

export default LocationBlock;
