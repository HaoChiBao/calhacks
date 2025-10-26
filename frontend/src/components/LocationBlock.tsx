import '../css/LocationBlock.css'

const LocationBlock = () => {
    return (
        <div className='location-block'>
            <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRNwO6mHJAzrUqPU8idTub9FvtiGCdRr3OSuQ&s" alt="" />
            <div className="details">
                <h3>Shibuya Crossing</h3>
                <p>Tokyo, Japan</p>
            </div>

            <div className="drag-indicator"></div>
        </div>
    )
}

export default LocationBlock