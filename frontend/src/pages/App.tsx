import { useState } from 'react';
import Background from '../components/Background';
import Chat from '../components/Chat';
import Content from '../components/Content';
import NavBar from '../components/NavBar';
import HotelBooking from '../components/HotelBooking';

import '../css/App.css';
import type { StrictPlanDays } from '../types/plan';

type Range = { start: Date | null; end: Date | null };

function App() {
  const [hideContent, setHideContent] = useState(true);
  const [hideBooking, setHideBooking] = useState(true);

  // lifted booking state
  const [destination, setDestination] = useState<string>('');
  const [coords, setCoords] = useState<{ lat: string; lon: string } | null>(null);
  const [duration, setDuration] = useState<Range>({ start: null, end: null });
  const [who, setWho] = useState<number>(1);

  // Correctly typed state + setter
  const [planDays, setPlanDays] = useState<StrictPlanDays>([]);

  return (
    
    <main className="App">
      <Background />

      <HotelBooking 
        hidden={hideBooking}
        setHidden={setHideBooking}
        destination={destination}
        coords={coords}
        duration={duration}
        who={who}
        />

      <NavBar />


      <div className="app-content">

      <Chat
        hideContent={hideContent}
        setHideContent={setHideContent}
        destination={destination}
        onDestinationChange={setDestination}
        onDestinationSelect={(c) => setCoords(c)}
        duration={duration}
        onDurationChange={setDuration}
        who={who}
        onWhoChange={setWho}
        planDays={planDays}
        setPlanDays={setPlanDays}
      />

      <Content
        hideContent={hideContent}
        setHideBooking={setHideBooking}
        destination={destination}
        onDestinationChange={setDestination}
        onDestinationSelect={(c) => setCoords(c)}
        duration={duration}
        onDurationChange={setDuration}
        who={who}
        onWhoChange={setWho}
        coords={coords}
        planDays={planDays}
        setPlanDays={setPlanDays}
      />

      <button
        className="toggle-btn"
        onClick={() => setHideContent((v) => !v)}
        style={{ position: 'fixed', right: 16, bottom: 16 }}
      >
        {hideContent ? 'Show content' : 'Show chat'}
      </button>
      </div>
    </main>
  );
}

export default App;
