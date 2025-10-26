import bg_image from '../assets/bg-gradient.png'
import '../css/Background.css'

const Background = () => {
    return (
        <div className='background-asset'>
            <img id = 'img-0' src={bg_image} alt="background" className='background-image'/>
            <img id = 'img-1' src={bg_image} alt="background" className='background-image'/>
        </div>
    )
}

export default Background