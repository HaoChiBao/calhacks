import bg_image from '../assets/bg-gradient.png'
import '../css/Background.css'

const Background = () => {
    return (
        <div className='background-asset'>
            <img src={bg_image} alt="background" className='background-image'/>
        </div>
    )
}

export default Background