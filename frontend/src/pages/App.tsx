import { useState } from 'react';
import Background from '../components/Background';
import Chat from '../components/Chat';
import Content from '../components/Content';
import '../css/App.css';

type Range = { start: Date | null; end: Date | null };

function App() {
  const [hideContent, setHideContent] = useState(true);

  // lifted booking state
  const [destination, setDestination] = useState<string>('');
  const [coords, setCoords] = useState<{ lat: string; lon: string } | null>(null);
  const [duration, setDuration] = useState<Range>({ start: null, end: null });
  const [who, setWho] = useState<number>(1);

  return (
    <main className="App">
      <Background />

      <Chat
        hideContent={hideContent}
        destination={destination}
        onDestinationChange={setDestination}
        onDestinationSelect={(c) => setCoords(c)}
        duration={duration}
        onDurationChange={setDuration}
        who={who}
        onWhoChange={setWho}
      />

      <Content
        hideContent={hideContent}
        destination={destination}
        onDestinationChange={setDestination}
        onDestinationSelect={(c) => setCoords(c)}
        duration={duration}
        onDurationChange={setDuration}
        who={who}
        onWhoChange={setWho}
        coords={coords}
      />


      <button onClick={() => setHideContent(!hideContent)}>test</button>
    </main>
  );
}

export default App;
