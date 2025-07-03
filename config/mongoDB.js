import dotenv from 'dotenv'
dotenv.config()


import mongoose from "mongoose";

const connectDB = async () =>{
    try {
        await mongoose.connect(process.env.MONGO_URL)
        console.log("Local Db connected")
    } catch (error) {
        console.error('Databse Connection Failed', error.messsage)
        process.exit(1)
    }
}

export default connectDB;